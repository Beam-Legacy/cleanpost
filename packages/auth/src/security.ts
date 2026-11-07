/**
 * The company's security settings applied to a session (S-12, DEC-34). The settings themselves and
 * their floors are packages/domain `company`; this is where they meet the session: how its second
 * step was done, how long it has been idle, where the request comes from.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, inArray, like } from 'drizzle-orm';
import { memberships, sessions, tenants, verifications, withUser, type Database } from '@cleanpost/db';
import { secondFactorSkipAllowed } from '@cleanpost/config';
import { company } from '@cleanpost/domain';

/** How a session's second step was done; null for a password alone (or a session from before DEC-34). */
export type SecondFactor = 'totp' | 'backup_code' | 'passkey' | 'trusted_device';

/** Why a company turns a session away (A-07 says which and what to do). */
export type BlockReason = 'passkeys_not_allowed' | 'trusted_devices_not_allowed' | 'network';

/**
 * The address the request came from. Behind a proxy (Railway, a load balancer) the last
 * `hops` entries of X-Forwarded-For were added by trusted proxies; anything before them is what the
 * client claimed and is ignored. TRUSTED_PROXY_HOPS sets it (default 1).
 */
export function clientIp(
  headers: Headers,
  hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1),
): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const list = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const at = list.length - Math.max(1, hops);
    return list[Math.max(0, at)] ?? null;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

/** May this session work in this company? Null when it may, else why not. */
export function companyAccess(
  security: company.SecuritySettings,
  session: { secondFactor: string | null },
  ip: string | null,
): BlockReason | null {
  if (!security.allowPasskeys && session.secondFactor === 'passkey') return 'passkeys_not_allowed';
  if (!security.trustedDevices && session.secondFactor === 'trusted_device')
    return 'trusted_devices_not_allowed';
  if (!company.ipAllowed(ip, security.ipAllowlist)) return 'network';
  return null;
}

/** Was a second factor entered recently enough to change security settings (step-up)? */
export async function stepUpFresh(db: Database, sessionId: string, now = new Date()): Promise<boolean> {
  const [s] = await db
    .select({ at: sessions.secondFactorAt, skipped: sessions.secondFactorSkippedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  // Preview only (PREVIEW_ALLOW_SKIP_2FA): a session that skipped two-factor setup has no second
  // factor to enter again, so there is nothing to step up with.
  if (s?.skipped && secondFactorSkipAllowed()) return true;
  return Boolean(s?.at && now.getTime() - s.at.getTime() <= company.STEP_UP_MINUTES * 60_000);
}

/** The companies' security settings for every active membership of a user. */
export async function membershipSecurity(db: Database, userId: string) {
  return withUser(db, userId, async (tx) => {
    const ms = await tx
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
    if (!ms.length) return [];
    const rows = await tx
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(
        inArray(
          tenants.id,
          ms.map((m) => m.tenantId),
        ),
      );
    return rows.map((r) => ({ tenantId: r.id, security: company.securitySettings(r.settings) }));
  });
}

/** A-02 offers "Trust this device" only when every company the person works in accepts it. */
export async function trustedDevicesAllowed(db: Database, userId: string): Promise<boolean> {
  const all = await membershipSecurity(db, userId);
  return all.length > 0 && all.every((c) => c.security.trustedDevices);
}

/**
 * The person between their password and their second step (A-02), from better-auth's signed
 * two-factor cookie: its value names a verification row whose value is the user ID.
 */
export async function pendingTwoFactorUser(
  db: Database,
  cookieValue: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!cookieValue) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(cookieValue);
  } catch {
    return null;
  }
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const value = raw.slice(0, dot);
  const signature = Buffer.from(raw.slice(dot + 1), 'base64');
  const expected = createHmac('sha256', secret).update(value).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  const [v] = await db
    .select({ userId: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, value), gt(verifications.expiresAt, new Date())));
  return v?.userId ?? null;
}

/** Forget every trusted device of a user (a company that does not accept them, or they asked). */
export async function forgetTrustedDevices(db: Database, userId: string): Promise<void> {
  await db
    .delete(verifications)
    .where(and(eq(verifications.value, userId), like(verifications.identifier, 'trust-device-%')));
}
