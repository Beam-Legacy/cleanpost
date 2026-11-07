import { and, eq, sql } from 'drizzle-orm';
import { secondFactorSkipAllowed } from '@cleanpost/config';
import { memberships, passkeys, sessions, tenants, withTenant, withUser, type Database } from '@cleanpost/db';
import { company, type policy } from '@cleanpost/domain';
import { SESSION_IDLE_MAX_SECONDS, type Auth } from './auth';
import { clientIp, companyAccess, membershipSecurity, type BlockReason } from './security';

type Actor = policy.Actor;

export interface SignedInUser {
  id: string;
  name: string;
  email: string;
}

export type SessionContext =
  | { status: 'signed_out'; reason?: 'expired' | 'inactive_user' }
  /**
   * Signed in but no second factor yet: only A-03 (set up two-factor) is allowed. canSkip is true
   * only in preview with PREVIEW_ALLOW_SKIP_2FA (skipSecondFactorForSession).
   */
  | { status: 'mfa_setup_required'; user: SignedInUser; sessionId: string; canSkip: boolean }
  /**
   * Signed in with a password alone by someone whose second factor is a passkey: the passkey is
   * still owed (DEC-34). Only the passkey step is allowed.
   */
  | { status: 'second_factor_required'; user: SignedInUser; sessionId: string }
  /** The chosen company turns this session away (S-12): A-07 says why. */
  | {
      status: 'company_blocked';
      user: SignedInUser;
      sessionId: string;
      tenantId: string;
      reason: BlockReason;
    }
  /** Signed in with MFA but no company chosen: only A-07 is allowed. */
  | { status: 'choose_company'; user: SignedInUser; sessionId: string }
  | {
      status: 'ok';
      user: SignedInUser;
      sessionId: string;
      tenantId: string;
      actor: Actor;
      /** The company's idle limit, for the sign-out warning (G-10). */
      idleMinutes: number;
    };

/**
 * Resolves who is calling and in which company, for every server route and action. Enforces the
 * second-factor requirement, an active membership in the chosen company and that company's S-12
 * settings (DEC-34): its idle and absolute session limits, whether it accepts passkeys and trusted
 * devices, and its IP allowlist. Before a company is chosen, the default limits apply.
 */
export async function getSessionContext(auth: Auth, db: Database, headers: Headers): Promise<SessionContext> {
  // Read without extending it first: the company's idle limit is judged on the last activity.
  const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (!found) return { status: 'signed_out' };
  const { session, user } = found;
  const extra = session as { secondFactor?: string | null; activeTenantId?: string | null };
  const now = Date.now();
  const lastActive = new Date(session.expiresAt).getTime() - SESSION_IDLE_MAX_SECONDS * 1000;
  const ageSeconds = (now - new Date(session.createdAt).getTime()) / 1000;
  const idleSeconds = (now - lastActive) / 1000;
  const expire = async () => {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    return { status: 'signed_out', reason: 'expired' } as const;
  };
  const limits = (s: company.SecuritySettings) =>
    ageSeconds > s.absoluteHours * 3600 || idleSeconds > s.idleMinutes * 60;
  if (limits(company.SECURITY_DEFAULTS) && !extra.activeTenantId) return expire();
  // Extend the session (better-auth's refresh) once the company has let it through.
  const refresh = async () => {
    if (idleSeconds > 60) await auth.api.getSession({ headers, query: { disableRefresh: false } });
  };
  if ((user as { status?: string }).status && (user as { status?: string }).status !== 'active') {
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    return { status: 'signed_out', reason: 'inactive_user' };
  }

  const who: SignedInUser = { id: user.id, name: user.name, email: user.email };
  const totp = Boolean(user.twoFactorEnabled);
  const passkey = await hasPasskey(db, user.id);
  // A password alone is one factor: someone whose second factor is a passkey still owes it.
  if (!totp && passkey && !extra.secondFactor) {
    await refresh();
    return { status: 'second_factor_required', user: who, sessionId: session.id };
  }
  if (!totp && !passkey) {
    const canSkip = secondFactorSkipAllowed();
    const [row] = canSkip
      ? await db
          .select({ skipped: sessions.secondFactorSkippedAt })
          .from(sessions)
          .where(eq(sessions.id, session.id))
      : [];
    if (!row?.skipped) {
      await refresh();
      return { status: 'mfa_setup_required', user: who, sessionId: session.id, canSkip };
    }
  }

  const tenantId = extra.activeTenantId;
  if (!tenantId) {
    await refresh();
    return { status: 'choose_company', user: who, sessionId: session.id };
  }

  const found2 = await withTenant(db, { tenantId, userId: user.id }, async (tx) => {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')));
    const [t] = await tx
      .select({ security: sql<unknown>`${tenants.settings}->'security'` })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return { membership: m, security: company.securitySettings({ security: t?.security }) };
  });
  const { membership, security } = found2;
  if (!membership) {
    await db.update(sessions).set({ activeTenantId: null }).where(eq(sessions.id, session.id));
    await refresh();
    return { status: 'choose_company', user: who, sessionId: session.id };
  }
  if (limits(security)) return expire();
  const blocked = companyAccess(security, { secondFactor: extra.secondFactor ?? null }, clientIp(headers));
  if (blocked) {
    await db.update(sessions).set({ activeTenantId: null }).where(eq(sessions.id, session.id));
    return { status: 'company_blocked', user: who, sessionId: session.id, tenantId, reason: blocked };
  }
  await refresh();
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
    idleMinutes: security.idleMinutes,
  };
}

async function hasPasskey(db: Database, userId: string): Promise<boolean> {
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

/**
 * A-07: switches the session to a company the user belongs to, unless that company turns this
 * session away (S-12: passkeys, trusted devices, IP allowlist); then it says why and stays out.
 */
export async function chooseCompany(
  db: Database,
  sessionId: string,
  userId: string,
  tenantId: string,
  ip: string | null = null,
): Promise<BlockReason | null> {
  const companies = await listCompanies(db, userId);
  if (!companies.some((c) => c.tenantId === tenantId)) throw new NotAMemberError();
  const [s] = await db
    .select({ secondFactor: sessions.secondFactor })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const security = (await membershipSecurity(db, userId)).find((c) => c.tenantId === tenantId)?.security;
  const blocked = security ? companyAccess(security, { secondFactor: s?.secondFactor ?? null }, ip) : null;
  if (blocked) return blocked;
  await db.update(sessions).set({ activeTenantId: tenantId }).where(eq(sessions.id, sessionId));
  return null;
}

export class SkipNotAllowedError extends Error {
  readonly code = 'FORBIDDEN';
  constructor() {
    super('Skipping two-factor setup is only allowed in preview');
    this.name = 'SkipNotAllowedError';
  }
}

/**
 * Preview only: lets this one session continue without a second factor. The next sign-in shows the
 * setup step again. Refused unless PREVIEW_ALLOW_SKIP_2FA is on in local or preview.
 */
export async function skipSecondFactorForSession(db: Database, sessionId: string): Promise<void> {
  if (!secondFactorSkipAllowed()) throw new SkipNotAllowedError();
  await db.update(sessions).set({ secondFactorSkippedAt: new Date() }).where(eq(sessions.id, sessionId));
}
