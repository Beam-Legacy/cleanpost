import { and, eq } from 'drizzle-orm';
import { memberships, passkeys, sessions, withTenant, withUser, type Database } from '@cleanpost/db';
import type { policy } from '@cleanpost/domain';
import { SESSION_ABSOLUTE_SECONDS, type Auth } from './auth';

type Actor = policy.Actor;

export interface SignedInUser {
  id: string;
  name: string;
  email: string;
}

export type SessionContext =
  | { status: 'signed_out'; reason?: 'expired' | 'inactive_user' }
  /** Signed in but no second factor yet: only A-03 (set up two-factor) is allowed. */
  | { status: 'mfa_setup_required'; user: SignedInUser }
  /** Signed in with MFA but no company chosen: only A-07 is allowed. */
  | { status: 'choose_company'; user: SignedInUser; sessionId: string }
  | { status: 'ok'; user: SignedInUser; sessionId: string; tenantId: string; actor: Actor };

/**
 * Resolves who is calling and in which company, for every server route and action. Enforces the
 * 12-hour absolute session limit (idle expiry is better-auth's), the second-factor requirement and
 * an active membership in the chosen company.
 */
export async function getSessionContext(auth: Auth, db: Database, headers: Headers): Promise<SessionContext> {
  const found = await auth.api.getSession({ headers, query: { disableRefresh: false } });
  if (!found) return { status: 'signed_out' };
  const { session, user } = found;

  const ageSeconds = (Date.now() - new Date(session.createdAt).getTime()) / 1000;
  if (ageSeconds > SESSION_ABSOLUTE_SECONDS) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    return { status: 'signed_out', reason: 'expired' };
  }
  if ((user as { status?: string }).status && (user as { status?: string }).status !== 'active') {
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    return { status: 'signed_out', reason: 'inactive_user' };
  }

  const who: SignedInUser = { id: user.id, name: user.name, email: user.email };
  if (!(await hasSecondFactor(db, user.id, Boolean(user.twoFactorEnabled)))) {
    return { status: 'mfa_setup_required', user: who };
  }

  const tenantId = (session as { activeTenantId?: string | null }).activeTenantId;
  if (!tenantId) return { status: 'choose_company', user: who, sessionId: session.id };

  const membership = await withTenant(db, { tenantId, userId: user.id }, async (tx) => {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')));
    return m;
  });
  if (!membership) {
    await db.update(sessions).set({ activeTenantId: null }).where(eq(sessions.id, session.id));
    return { status: 'choose_company', user: who, sessionId: session.id };
  }
  return {
    status: 'ok',
    user: who,
    sessionId: session.id,
    tenantId,
    actor: {
      userId: user.id,
      role: membership.role as Actor['role'],
      isOwner: membership.isOwner,
      clientScope: membership.clientScope as Actor['clientScope'],
      clientIds: membership.clientIds,
    },
  };
}

async function hasSecondFactor(db: Database, userId: string, totpEnabled: boolean): Promise<boolean> {
  if (totpEnabled) return true;
  const [pk] = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .limit(1);
  return Boolean(pk);
}

export class NotAMemberError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Not a member of this company');
    this.name = 'NotAMemberError';
  }
}

/** A-07: the companies a signed-in user can enter. */
export async function listCompanies(db: Database, userId: string) {
  return withUser(db, userId, (tx) =>
    tx
      .select({ tenantId: memberships.tenantId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'))),
  );
}

/** A-07: switches the session to a company the user belongs to. */
export async function chooseCompany(db: Database, sessionId: string, userId: string, tenantId: string) {
  const companies = await listCompanies(db, userId);
  if (!companies.some((c) => c.tenantId === tenantId)) throw new NotAMemberError();
  await db.update(sessions).set({ activeTenantId: tenantId }).where(eq(sessions.id, sessionId));
}
