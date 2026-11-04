'use server';
/**
 * S-01 / S-02 user actions: invite (E-01 email), resend, revoke. Admins and the owner only; every
 * step is audited in packages/auth. The invite link is the only place the token appears.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createInvitations,
  endMemberSessions,
  resendInvitation,
  resetMemberTwoFactor,
  revokeInvitation,
  setMemberStatus,
  updateMemberAccess,
  type InviteRole,
  type MemberRefusal,
} from '@cleanpost/auth';
import { now as clockNow } from '@cleanpost/clock';
import { authEnvSchema, inviteLinksShown, parseEnv } from '@cleanpost/config';
import { tenants, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { inviteEmail } from '@cleanpost/email';
import { createLogger } from '@cleanpost/log';
import { unassignItemsOf } from '@cleanpost/work';
import { getDb, getMailer } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-users' });

export interface UserActionResult {
  ok: boolean;
  message: string;
  /** Per address, for S-02's inline errors. */
  refused?: { email: string; reason: string }[];
  /** Local and preview with email off only (inviteLinksShown): the links to pass on by hand. */
  links?: { email: string; url: string }[];
}

const REFUSED: Record<string, string> = {
  already_member: 'is already a member of this company',
  already_invited: 'already has an invite waiting; resend it from the list',
  invalid_email: 'is not an email address',
};

async function admin(): Promise<ActiveContext> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'users.manage');
  return ctx;
}

/** E-01 to one address. A failed send leaves the invite in place (Resend tries again). */
async function sendInvite(
  ctx: ActiveContext,
  to: string,
  token: string,
  expiresAt: Date,
  role: InviteRole,
  clientCount: number | null,
): Promise<{ sent: boolean; url: string }> {
  const { APP_URL } = parseEnv(authEnvSchema.pick({ APP_URL: true }));
  const url = `${new URL(APP_URL).origin}/invite?token=${encodeURIComponent(token)}`;
  const [t] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ name: tenants.name, timeZone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId)),
  );
  try {
    await getMailer().send(
      to,
      'E-01',
      inviteEmail({
        inviterName: ctx.user.name,
        tenantName: t?.name ?? 'your billing company',
        role,
        clientCount,
        url,
        expiresAt,
        timeZone: t?.timeZone ?? 'America/Los_Angeles',
      }),
    );
    return { sent: true, url };
  } catch (err) {
    // No address or link in the log: the error code is enough to see that mail is down.
    log.warn({ template: 'E-01', code: (err as { code?: string }).code ?? 'unknown' }, 'invite email failed');
    return { sent: false, url };
  }
}

const inviteInput = z.object({
  emails: z.string().min(3).max(2000),
  role: z.enum(['admin', 'biller', 'viewer']),
  clientIds: z.array(z.uuid()).max(500),
});

/** S-02: one invite per address (comma or line separated), each with its E-01 email. */
export async function inviteUsers(input: z.infer<typeof inviteInput>): Promise<UserActionResult> {
  const ctx = await admin();
  const data = inviteInput.parse(input);
  if (data.role !== 'admin' && data.clientIds.length === 0)
    return { ok: false, message: 'Choose the clients this person will work on.' };
  const emails = data.emails.split(/[,;\s]+/).filter(Boolean);
  if (emails.length > 20) return { ok: false, message: 'Invite up to 20 people at a time.' };
  const access = { role: data.role, clientIds: data.role === 'admin' ? ('all' as const) : data.clientIds };
  const results = await createInvitations(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    emails,
    access,
    clockNow(),
  );
  const made = results.filter((r) => r.invite);
  const clientCount = access.clientIds === 'all' ? null : access.clientIds.length;
  const mails = [];
  for (const r of made)
    mails.push({
      email: r.email,
      ...(await sendInvite(ctx, r.email, r.invite!.token, r.invite!.expiresAt, data.role, clientCount)),
    });
  const unsent = mails.filter((m) => !m.sent).length;
  log.info({ invited: made.length, unsent, refused: results.length - made.length }, 'invites made');
  revalidatePath('/settings/users');
  const refused = results
    .filter((r) => r.refused)
    .map((r) => ({ email: r.email, reason: REFUSED[r.refused!] ?? 'was not invited' }));
  const links = inviteLinksShown() ? mails.map((m) => ({ email: m.email, url: m.url })) : undefined;
  const n = made.length;
  return {
    ok: n > 0,
    message:
      n === 0
        ? 'No invites were sent.'
        : links
          ? `${n === 1 ? 'Invite' : `${n} invites`} ready. Email is off here: pass on the ${n === 1 ? 'link' : 'links'} below.`
          : unsent
            ? `${n === 1 ? 'Invite saved' : `${n} invites saved`}, but ${unsent === 1 ? 'one email' : `${unsent} emails`} did not go out. Use Resend in the list.`
            : `${n === 1 ? 'Invite sent' : `${n} invites sent`}. ${n === 1 ? 'It expires' : 'They expire'} in 7 days.`,
    refused,
    ...(links ? { links } : {}),
  };
}

export async function resendInvite(invitationId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const id = z.uuid().parse(invitationId);
  const res = await resendInvitation(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    id,
    clockNow(),
  );
  if (!res.ok) return { ok: false, message: 'That invite can no longer be resent.' };
  const mail = await sendInvite(ctx, res.email, res.token, res.expiresAt, res.role, res.clientCount);
  revalidatePath('/settings/users');
  if (inviteLinksShown())
    return {
      ok: true,
      message: 'New link made; the earlier one no longer works. Email is off here: pass this one on.',
      links: [{ email: res.email, url: mail.url }],
    };
  return mail.sent
    ? { ok: true, message: 'Invite sent again. The earlier link no longer works.' }
    : { ok: false, message: 'The email did not go out. Try again in a few minutes.' };
}

export async function revokeInvite(invitationId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const id = z.uuid().parse(invitationId);
  const ok = await revokeInvitation(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, clockNow());
  revalidatePath('/settings/users');
  return ok
    ? { ok: true, message: 'Invite withdrawn. The link no longer works.' }
    : { ok: false, message: 'That invite was already used or withdrawn.' };
}

/* S-03 Edit user ---------------------------------------------------------------------------- */

const MEMBER_REFUSED: Record<MemberRefusal, string> = {
  not_found: 'That person is not in this company.',
  owner: "The owner's access is not changed here.",
  self: 'You cannot change your own access. Ask another admin.',
  clients_required: 'Choose the clients this person will work on.',
  unknown_client: 'One of those clients is not in this company.',
  other_company:
    'They also work in another company, so their two-factor is theirs to manage. They can use a recovery code, or ask Cleanpost support.',
  invalid_state: 'That change was already made.',
};

const items = (n: number) => (n === 1 ? '1 open item' : `${n} open items`);
const ctxOf = (ctx: ActiveContext) => ({ tenantId: ctx.tenantId, userId: ctx.user.id });

const accessInput = z.object({
  role: z.enum(['admin', 'biller', 'viewer']),
  clientIds: z.array(z.uuid()).max(500),
});

/** Role and clients; open items for clients they no longer see go back to the queue. */
export async function saveMemberAccess(
  membershipId: string,
  input: z.infer<typeof accessInput>,
): Promise<UserActionResult> {
  const ctx = await admin();
  const id = z.uuid().parse(membershipId);
  const data = accessInput.parse(input);
  const res = await updateMemberAccess(
    getDb(),
    ctxOf(ctx),
    id,
    { role: data.role, clientIds: data.role === 'admin' ? 'all' : data.clientIds },
    clockNow(),
  );
  if (!res.ok) return { ok: false, message: MEMBER_REFUSED[res.reason] };
  if (!res.changed) return { ok: true, message: 'Nothing to save.' };
  const handedBack = await unassignItemsOf(getDb(), ctxOf(ctx), res.userId, res.keep);
  revalidatePath('/settings/users');
  return {
    ok: true,
    message: handedBack ? `Saved. ${items(handedBack)} for other clients went back to the queue.` : 'Saved.',
  };
}

/** Deactivate: access ends now, their sessions here end, their open items go back to the queue. */
export async function deactivateMember(membershipId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const id = z.uuid().parse(membershipId);
  const res = await setMemberStatus(getDb(), ctxOf(ctx), id, 'deactivate', clockNow());
  if (!res.ok) return { ok: false, message: MEMBER_REFUSED[res.reason] };
  const handedBack = await unassignItemsOf(getDb(), ctxOf(ctx), res.userId, 'none');
  log.info({ handedBack }, 'member deactivated');
  revalidatePath('/settings/users');
  return {
    ok: true,
    message: `Deactivated.${handedBack ? ` ${items(handedBack)} went back to the queue.` : ''}`,
  };
}

export async function reactivateMember(membershipId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const res = await setMemberStatus(
    getDb(),
    ctxOf(ctx),
    z.uuid().parse(membershipId),
    'reactivate',
    clockNow(),
  );
  revalidatePath('/settings/users');
  return res.ok
    ? { ok: true, message: 'Reactivated. They can sign in again.' }
    : { ok: false, message: MEMBER_REFUSED[res.reason] };
}

export async function signOutMember(membershipId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const res = await endMemberSessions(getDb(), ctxOf(ctx), z.uuid().parse(membershipId));
  revalidatePath('/settings/users');
  if (!res.ok) return { ok: false, message: MEMBER_REFUSED[res.reason] };
  return {
    ok: true,
    message: res.ended
      ? `Signed out of ${res.ended === 1 ? '1 session' : `${res.ended} sessions`}.`
      : 'They had no sessions open here.',
  };
}

export async function resetMemberTwoFactorAction(membershipId: string): Promise<UserActionResult> {
  const ctx = await admin();
  const res = await resetMemberTwoFactor(getDb(), ctxOf(ctx), z.uuid().parse(membershipId));
  revalidatePath('/settings/users');
  return res.ok
    ? { ok: true, message: 'Two-factor reset. They set it up again at their next sign-in.' }
    : { ok: false, message: MEMBER_REFUSED[res.reason] };
}
