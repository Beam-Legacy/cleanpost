/**
 * S-03 Edit user (docs/03 Membership): an admin changes a member's role and clients, resets their
 * two-factor, ends their sessions, or deactivates and reactivates them. Everything runs inside the
 * admin's company (RLS) and is audited. A person can belong to several companies, so what one
 * company's admin can do to their sign-in is limited to that company: sessions end only where this
 * company is the active one, and two-factor is reset only for people who work nowhere else. The
 * owner's membership is not edited here, and nobody edits their own.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  clients,
  memberships,
  passkeys,
  recordAudit,
  sessions,
  twoFactors,
  users,
  withTenant,
  type Database,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { InviteAccess } from './invitations';

export type MemberRefusal =
  | 'not_found'
  /** The owner's role, access and status are not edited in S-03. */
  | 'owner'
  /** Nobody edits their own role, access or status. */
  | 'self'
  | 'clients_required'
  | 'unknown_client'
  /** Two-factor belongs to the person, not one company: refused when they work elsewhere too. */
  | 'other_company'
  | 'invalid_state';

export type MemberResult<T = object> = ({ ok: true } & T) | { ok: false; reason: MemberRefusal };

type Ctx = { tenantId: string; userId: string };
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

async function lockMember(tx: Tx, membershipId: string) {
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, membershipId)).for('update');
  return m;
}

const guard = (m: typeof memberships.$inferSelect | undefined, ctx: Ctx): MemberRefusal | null =>
  !m ? 'not_found' : m.isOwner ? 'owner' : m.userId === ctx.userId ? 'self' : null;

/**
 * Role and clients. Admins see every client; billers and viewers need at least one. Returns the
 * clients the person keeps, so the caller can hand back open items for the others.
 */
export async function updateMemberAccess(
  db: Database,
  ctx: Ctx,
  membershipId: string,
  access: InviteAccess,
  now: Date,
): Promise<MemberResult<{ userId: string; keep: 'all' | string[]; changed: boolean }>> {
  return withTenant(db, ctx, async (tx) => {
    const m = await lockMember(tx, membershipId);
    const refused = guard(m, ctx);
    if (refused || !m) return { ok: false, reason: refused ?? 'not_found' };
    const all = access.role === 'admin' || access.clientIds === 'all';
    if (access.role !== 'admin' && (access.clientIds === 'all' || access.clientIds.length === 0))
      return { ok: false, reason: 'clients_required' };
    const ids = all ? [] : [...new Set(access.clientIds as string[])].sort();
    if (ids.length) {
      const found = await tx.select({ id: clients.id }).from(clients).where(inArray(clients.id, ids));
      if (found.length !== ids.length) return { ok: false, reason: 'unknown_client' };
    }
    const scope = all ? 'all' : 'list';
    const roleChanged = m.role !== access.role;
    const before = [...m.clientIds].sort();
    const clientsChanged =
      m.clientScope !== scope || (scope === 'list' && before.join(',') !== ids.join(','));
    if (!roleChanged && !clientsChanged)
      return { ok: true, userId: m.userId, keep: all ? 'all' : ids, changed: false };
    await tx
      .update(memberships)
      .set({ role: access.role, clientScope: scope, clientIds: ids, updatedAt: now })
      .where(eq(memberships.id, m.id));
    if (roleChanged)
      await recordAudit(tx, {
        actor: `user:${ctx.userId}`,
        action: 'user.role_changed',
        entityType: 'membership',
        entityId: m.id,
        metadata: { from: m.role, to: access.role },
      });
    if (clientsChanged)
      await recordAudit(tx, {
        actor: `user:${ctx.userId}`,
        action: 'user.clients_changed',
        entityType: 'membership',
        entityId: m.id,
        metadata: {
          from: m.clientScope === 'all' ? 'all' : m.clientIds.length,
          to: all ? 'all' : ids.length,
        },
      });
    return { ok: true, userId: m.userId, keep: all ? 'all' : ids, changed: true };
  });
}

/** Deactivate (access ends at once: their sessions in this company end) or reactivate. */
export async function setMemberStatus(
  db: Database,
  ctx: Ctx,
  membershipId: string,
  event: state.MembershipEvent,
  now: Date,
): Promise<MemberResult<{ userId: string }>> {
  return withTenant(db, ctx, async (tx) => {
    const m = await lockMember(tx, membershipId);
    const refused = guard(m, ctx);
    if (refused || !m) return { ok: false, reason: refused ?? 'not_found' };
    const next = state.nextMembershipState(m.status as state.MembershipState, event);
    if (!next.ok) return { ok: false, reason: 'invalid_state' };
    await tx.update(memberships).set({ status: next.value, updatedAt: now }).where(eq(memberships.id, m.id));
    if (event === 'deactivate')
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, m.userId), eq(sessions.activeTenantId, ctx.tenantId)));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: event === 'deactivate' ? 'user.deactivated' : 'user.reactivated',
      entityType: 'membership',
      entityId: m.id,
    });
    return { ok: true, userId: m.userId };
  });
}

/** Sign out everywhere: every session of theirs with this company open ends. */
export async function endMemberSessions(
  db: Database,
  ctx: Ctx,
  membershipId: string,
): Promise<MemberResult<{ ended: number }>> {
  return withTenant(db, ctx, async (tx) => {
    const m = await lockMember(tx, membershipId);
    const refused = guard(m, ctx);
    if (refused || !m) return { ok: false, reason: refused ?? 'not_found' };
    const ended = await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, m.userId), eq(sessions.activeTenantId, ctx.tenantId)))
      .returning({ id: sessions.id });
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'user.sessions_revoked',
      entityType: 'membership',
      entityId: m.id,
      metadata: { sessions: ended.length },
    });
    return { ok: true, ended: ended.length };
  });
}

/**
 * Reset two-factor: their authenticator and passkeys are removed and their sessions end, so the
 * next sign-in asks them to set it up again (A-03). Refused for people in another company too.
 */
export async function resetMemberTwoFactor(
  db: Database,
  ctx: Ctx,
  membershipId: string,
): Promise<MemberResult> {
  return withTenant(db, ctx, async (tx) => {
    const m = await lockMember(tx, membershipId);
    const refused = guard(m, ctx);
    if (refused || !m) return { ok: false, reason: refused ?? 'not_found' };
    if (await memberElsewhere(tx, m.userId)) return { ok: false, reason: 'other_company' };
    await tx.delete(twoFactors).where(eq(twoFactors.userId, m.userId));
    await tx.delete(passkeys).where(eq(passkeys.userId, m.userId));
    await tx.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, m.userId));
    await tx.delete(sessions).where(eq(sessions.userId, m.userId));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'user.two_factor_reset',
      entityType: 'membership',
      entityId: m.id,
    });
    return { ok: true };
  });
}

/**
 * Whether the person is active in another company. Memberships are tenant-scoped (RLS), so this
 * asks app.member_elsewhere (migration 0016), which answers only yes or no.
 */
async function memberElsewhere(tx: Tx, userId: string): Promise<boolean> {
  const res = await tx.execute<{ elsewhere: boolean }>(
    sql`select app.member_elsewhere(${userId}::uuid) as elsewhere`,
  );
  return Boolean(res.rows[0]?.elsewhere);
}
