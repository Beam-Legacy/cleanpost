/**
 * Invites (S-02, E-01, A-06; docs/03 Invitation): an admin invites a person by email with a role and
 * client access; they accept once, within 7 days. A new person first makes their sign-in (name and
 * password) and sets up two-factor; someone with a Cleanpost account signs in. Either way they then
 * join, signed in as the invited email. The token goes out once by email; only its SHA-256 is kept.
 * Every step is audited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { invitations, memberships, recordAudit, users, withTenant, type Database } from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { Auth } from './auth';
import { createUserWithPassword } from './users';

export type InviteRole = 'admin' | 'biller' | 'viewer';

export interface InviteAccess {
  role: InviteRole;
  /** 'all', or the clients a biller or viewer may see (required for them). */
  clientIds: 'all' | string[];
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const expiry = (now: Date) => new Date(now.getTime() + state.INVITE_DAYS * 86_400_000);

export type InviteRefusal = 'already_member' | 'already_invited' | 'invalid_email';

export interface InviteResult {
  email: string;
  /** Present when an invite was made: the token for the email link (never stored). */
  invite?: { id: string; token: string; expiresAt: Date };
  refused?: InviteRefusal;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** S-02: one invite per address; members and addresses with a live invite are refused. */
export async function createInvitations(
  db: Database,
  ctx: { tenantId: string; userId: string },
  emails: string[],
  access: InviteAccess,
  now: Date,
): Promise<InviteResult[]> {
  if (access.role !== 'admin' && (access.clientIds === 'all' || access.clientIds.length === 0))
    throw new Error('billers and viewers need at least one client');
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  return withTenant(db, ctx, async (tx) => {
    const out: InviteResult[] = [];
    const known = wanted.length
      ? await tx
          .select({ email: users.email, status: memberships.status })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(inArray(users.email, wanted))
      : [];
    const live = wanted.length
      ? await tx
          .select({ email: invitations.email, expiresAt: invitations.expiresAt })
          .from(invitations)
          .where(and(inArray(invitations.email, wanted), eq(invitations.status, 'pending')))
      : [];
    for (const email of wanted) {
      if (!EMAIL.test(email) || email.length > 254) {
        out.push({ email, refused: 'invalid_email' });
        continue;
      }
      if (known.some((k) => k.email === email && k.status !== 'deactivated')) {
        out.push({ email, refused: 'already_member' });
        continue;
      }
      if (live.some((l) => l.email === email && !state.invitationExpired(l.expiresAt, now))) {
        out.push({ email, refused: 'already_invited' });
        continue;
      }
      const token = newToken();
      const expiresAt = expiry(now);
      const [row] = await tx
        .insert(invitations)
        .values({
          tenantId: ctx.tenantId,
          email,
          role: access.role,
          clientScope: access.clientIds === 'all' ? 'all' : 'list',
          clientIds: access.clientIds === 'all' ? [] : access.clientIds,
          invitedBy: ctx.userId,
          tokenHash: hashToken(token),
          expiresAt,
        })
        .returning({ id: invitations.id });
      await recordAudit(tx, {
        actor: `user:${ctx.userId}`,
        action: 'user.invited',
        entityType: 'invitation',
        entityId: row!.id,
        metadata: {
          role: access.role,
          clients: access.clientIds === 'all' ? 'all' : access.clientIds.length,
        },
      });
      out.push({ email, invite: { id: row!.id, token, expiresAt } });
    }
    return out;
  });
}

/** Resend: a new token and 7 more days; the old link stops working. */
export async function resendInvitation(
  db: Database,
  ctx: { tenantId: string; userId: string },
  invitationId: string,
  now: Date,
): Promise<
  | { ok: true; email: string; token: string; expiresAt: Date; role: InviteRole; clientCount: number | null }
  | { ok: false }
> {
  return withTenant(db, ctx, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invitationId)).for('update');
    if (!inv || !state.nextInvitationState(inv.status as state.InvitationState, 'resend').ok)
      return { ok: false };
    const token = newToken();
    const expiresAt = expiry(now);
    await tx
      .update(invitations)
      .set({ tokenHash: hashToken(token), expiresAt, updatedAt: now })
      .where(eq(invitations.id, inv.id));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'user.invite_resent',
      entityType: 'invitation',
      entityId: inv.id,
    });
    return {
      ok: true,
      email: inv.email,
      token,
      expiresAt,
      role: inv.role as InviteRole,
      clientCount: inv.clientScope === 'all' ? null : inv.clientIds.length,
    };
  });
}

export async function revokeInvitation(
  db: Database,
  ctx: { tenantId: string; userId: string },
  invitationId: string,
  now: Date,
): Promise<boolean> {
  return withTenant(db, ctx, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invitationId)).for('update');
    const next = inv && state.nextInvitationState(inv.status as state.InvitationState, 'revoke');
    if (!inv || !next?.ok) return false;
    await tx
      .update(invitations)
      .set({ status: next.value, updatedAt: now })
      .where(eq(invitations.id, inv.id));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'user.invite_revoked',
      entityType: 'invitation',
      entityId: inv.id,
    });
    return true;
  });
}

export interface InviteView {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: InviteRole;
  /** null = all clients */
  clientCount: number | null;
  inviterName: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  /** Whether a Cleanpost account already uses this email (sign in to accept). */
  existingUser: boolean;
}

/** A-06: the invite behind a link, through app.invitation_by_token (the reader is not signed in). */
export async function invitationByToken(db: Database, token: string, now: Date): Promise<InviteView | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const res = await db.execute<{
    id: string;
    tenant_id: string;
    tenant_name: string;
    email: string;
    role: InviteRole;
    client_scope: string;
    client_count: number;
    inviter_name: string;
    status: 'pending' | 'accepted' | 'revoked';
    expires_at: string | Date;
  }>(sql`select * from app.invitation_by_token(${hashToken(token)})`);
  const r = res.rows[0];
  if (!r) return null;
  const expiresAt = new Date(r.expires_at);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, r.email)).limit(1);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    email: r.email,
    role: r.role,
    clientCount: r.client_scope === 'all' ? null : r.client_count,
    inviterName: r.inviter_name,
    status: r.status === 'pending' && state.invitationExpired(expiresAt, now) ? 'expired' : r.status,
    expiresAt,
    existingUser: Boolean(existing),
  };
}

export type AcceptRefusal = 'not_found' | 'expired' | 'used' | 'existing_user' | 'wrong_user';

/** Inside the invite's tenant: the membership (new, or a deactivated one back) and the invite accepted. */
async function join(db: Database, invite: InviteView, token: string, userId: string, now: Date) {
  return withTenant(db, { tenantId: invite.tenantId, userId }, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, invite.id), eq(invitations.tokenHash, hashToken(token))))
      .for('update');
    const next = inv && state.nextInvitationState(inv.status as state.InvitationState, 'accept');
    if (!inv || !next?.ok) return false;
    const access = {
      role: inv.role,
      clientScope: inv.clientScope,
      clientIds: inv.clientIds,
      status: 'active',
      isOwner: false,
      updatedAt: now,
    };
    await tx
      .insert(memberships)
      .values({ tenantId: inv.tenantId, userId, ...access })
      .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: access });
    await tx
      .update(invitations)
      .set({ status: next.value, acceptedAt: now, acceptedBy: userId, updatedAt: now })
      .where(eq(invitations.id, inv.id));
    await recordAudit(tx, {
      actor: `user:${userId}`,
      action: 'user.invite_accepted',
      entityType: 'invitation',
      entityId: inv.id,
      metadata: { role: inv.role },
    });
    return true;
  });
}

/**
 * A-06 for a new person: the sign-in only (name, email, password). They join the company after
 * setting up two-factor (A-03), back on the invite with acceptInvitationAsUser, so no membership
 * exists without a second factor. The invite stays pending until then.
 */
export async function acceptInvitationAsNewUser(
  auth: Auth,
  db: Database,
  token: string,
  input: { name: string; password: string },
  now: Date,
): Promise<{ ok: true; email: string } | { ok: false; reason: AcceptRefusal }> {
  const invite = await invitationByToken(db, token, now);
  if (!invite) return { ok: false, reason: 'not_found' };
  if (invite.status === 'expired') return { ok: false, reason: 'expired' };
  if (invite.status !== 'pending') return { ok: false, reason: 'used' };
  if (invite.existingUser) return { ok: false, reason: 'existing_user' };
  await createUserWithPassword(auth, { name: input.name, email: invite.email, password: input.password });
  return { ok: true, email: invite.email };
}

/**
 * A-06 join: signed in (with two-factor) as the invited email, they join the company. Used both by
 * people who already had an account and by new people once their two-factor is set up.
 */
export async function acceptInvitationAsUser(
  db: Database,
  token: string,
  user: { id: string; email: string },
  now: Date,
): Promise<{ ok: true; tenantId: string } | { ok: false; reason: AcceptRefusal }> {
  const invite = await invitationByToken(db, token, now);
  if (!invite) return { ok: false, reason: 'not_found' };
  if (invite.status === 'expired') return { ok: false, reason: 'expired' };
  if (invite.status !== 'pending') return { ok: false, reason: 'used' };
  if (invite.email !== user.email.toLowerCase()) return { ok: false, reason: 'wrong_user' };
  return (await join(db, invite, token, user.id, now))
    ? { ok: true, tenantId: invite.tenantId }
    : { ok: false, reason: 'used' };
}
