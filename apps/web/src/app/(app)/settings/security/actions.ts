'use server';
/**
 * S-12 Security (DEC-34): passkeys, trusted devices, idle and absolute session limits within the
 * floors, the IP allowlist and who may export patient-level data. Saving needs the second factor
 * entered in the last 10 minutes (step-up); a list that leaves out the saver's own address is
 * refused. Admins with security.manage; audited with what changed.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { chooseCompany, clientIp, stepUpFresh } from '@cleanpost/auth';
import { recordAudit, tenants, withTenant } from '@cleanpost/db';
import { company, policy } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { getContext, requireActiveContext } from '@/lib/session';

export interface SecurityInput {
  allowPasskeys: boolean;
  trustedDevices: boolean;
  idleMinutes: number;
  absoluteHours: number;
  /** The text box: one address or range per line. */
  allowlistText: string;
  patientExports: string;
}

export type SecurityResult =
  { ok: true; message: string } | { ok: false; message: string; field?: 'allowlist'; stepUp?: boolean };

export async function saveSecuritySettings(input: SecurityInput): Promise<SecurityResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'security.manage');
  const list = company.parseAllowlist(input.allowlistText ?? '');
  if (!list.ok)
    return {
      ok: false,
      field: 'allowlist',
      message: `Line ${list.line} is not an IP address or range: "${list.text}".`,
    };
  const parsed = company.securitySchema.safeParse({ ...input, ipAllowlist: list.entries });
  if (!parsed.success) return { ok: false, message: 'Choose from the options shown, then save again.' };
  const next = parsed.data;
  const ip = clientIp(await headers());
  if (next.ipAllowlist.length && !company.ipAllowed(ip, next.ipAllowlist))
    return {
      ok: false,
      field: 'allowlist',
      message: ip
        ? `This list leaves out your own address (${ip}), so saving it would sign you out. Add it first.`
        : "Cleanpost can't see the address you're connecting from, so it can't check this list won't lock you out.",
    };
  const db = getDb();
  if (!(await stepUpFresh(db, ctx.sessionId)))
    return { ok: false, stepUp: true, message: 'Confirm it is you to save security settings.' };

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .for('update');
    const before = company.securitySettings(t?.settings);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(next) as (keyof company.SecuritySettings)[]) {
      if (JSON.stringify(before[k]) === JSON.stringify(next[k])) continue;
      // The allowlist by size: the audit log keeps what changed, the page keeps the addresses.
      if (k === 'ipAllowlist')
        changes.allowlistEntries = { from: before.ipAllowlist.length, to: next.ipAllowlist.length };
      else changes[k] = { from: before[k], to: next[k] };
    }
    if (!Object.keys(changes).length) return { ok: true, message: 'Nothing to save.' };
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    await tx
      .update(tenants)
      .set({ settings: { ...settings, security: next }, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenantId));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'security.settings_updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: { changes },
    });
    revalidatePath('/settings/security');
    return { ok: true, message: 'Security settings saved. They apply at everyone’s next page view.' };
  });
}

/**
 * Step-up with a passkey signs in afresh (a new session, with no company yet): back into the same
 * company before saving. Refused like any company choice when the company turns it away.
 */
export async function resumeCompanyAction(tenantId: string): Promise<boolean> {
  const ctx = await getContext();
  if (ctx.status !== 'choose_company' && ctx.status !== 'ok') return false;
  const blocked = await chooseCompany(
    getDb(),
    ctx.sessionId,
    ctx.user.id,
    tenantId,
    clientIp(await headers()),
  );
  return blocked === null;
}
