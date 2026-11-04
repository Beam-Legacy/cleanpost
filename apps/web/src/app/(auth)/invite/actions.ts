'use server';
/**
 * A-06 Accept invite. A new person makes their sign-in, sets up two-factor (A-03) and comes back to
 * join; someone who already has a Cleanpost account signs in and joins. Joining needs a full sign-in,
 * so nobody gets a membership without a second factor. The token comes from the E-01 link;
 * packages/auth checks it against the stored hash and audits the accept.
 */
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  PASSWORD_MIN_LENGTH,
  acceptInvitationAsNewUser,
  acceptInvitationAsUser,
  chooseCompany,
  type AcceptRefusal,
} from '@cleanpost/auth';
import { now as clockNow } from '@cleanpost/clock';
import { recordAudit, withTenant } from '@cleanpost/db';
import { createLogger } from '@cleanpost/log';
import { getAuth, getDb, syncClock } from '@/lib/server';
import { getContext } from '@/lib/session';

const log = createLogger({ name: 'web-invite' });
const Token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

const REFUSED: Record<AcceptRefusal, string> = {
  not_found: 'This invite link no longer works. Ask the person who invited you to send it again.',
  expired: 'This invite has expired. Ask the person who invited you to send it again.',
  used: 'This invite was already used. Sign in instead.',
  existing_user: 'A Cleanpost account already uses this email. Sign in to accept.',
  wrong_user: 'This invite is for a different email address.',
};

const NewUser = z.object({
  token: Token,
  name: z.string().trim().min(1, 'Enter your full name.').max(120),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(128, 'Use at most 128 characters.'),
  terms: z.literal(true, { error: 'Agree to the terms of use to continue.' }),
});

export type AcceptResult = { ok: true; email: string } | { ok: false; message: string };

/** New person: the sign-in only. The browser then signs in and goes to A-03, then back to join. */
export async function acceptAsNewUserAction(input: {
  token: string;
  name: string;
  password: string;
  terms: boolean;
}): Promise<AcceptResult> {
  const parsed = NewUser.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  await syncClock();
  const res = await acceptInvitationAsNewUser(
    getAuth(),
    getDb(),
    parsed.data.token,
    { name: parsed.data.name, password: parsed.data.password },
    clockNow(),
  );
  log.info({ outcome: res.ok ? 'accepted' : res.reason }, 'invite accept (new user)');
  return res.ok ? { ok: true, email: res.email } : { ok: false, message: REFUSED[res.reason] };
}

/** Signed in (with two-factor) as the invited email: join the company and switch to it. */
export async function joinAction(formData: FormData) {
  const token = Token.safeParse(formData.get('token'));
  if (!token.success) redirect('/invite');
  const back = `/invite?token=${encodeURIComponent(token.data)}`;
  const ctx = await getContext();
  if (ctx.status !== 'ok' && ctx.status !== 'choose_company')
    redirect(`/sign-in?next=${encodeURIComponent(back)}`);
  const db = getDb();
  const res = await acceptInvitationAsUser(db, token.data, ctx.user, clockNow());
  log.info({ outcome: res.ok ? 'accepted' : res.reason }, 'invite accept (signed in)');
  // A refused join goes back to the invite page, which says why (expired, used, another address).
  if (!res.ok) redirect(back);
  await chooseCompany(db, ctx.sessionId, ctx.user.id, res.tenantId);
  await withTenant(db, { tenantId: res.tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'session.company_chosen',
      entityType: 'tenant',
      entityId: res.tenantId,
    }),
  );
  redirect('/work');
}
