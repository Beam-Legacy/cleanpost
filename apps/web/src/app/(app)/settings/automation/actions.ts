'use server';
/**
 * S-04: the company's release threshold and each client's own. Admins only; audited with before and
 * after. Applies to claims scrubbed after the save (claims already scrubbed keep their decision).
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { clients, recordAudit, tenants, withTenant } from '@cleanpost/db';
import { companyReleaseThreshold, policy } from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export interface AutomationActionResult {
  ok: boolean;
  message: string;
}

const Threshold = z.number().int().min(0).max(100);
const label = (n: number) => (n >= 100 ? 'Review everything' : String(n));

export async function saveCompanyThreshold(value: number): Promise<AutomationActionResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'automation.manage');
  const next = Threshold.parse(value);
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .for('update');
    const before = companyReleaseThreshold(t?.settings);
    if (before === next) return { before, changed: false };
    await tx
      .update(tenants)
      .set({ settings: { ...((t?.settings ?? {}) as object), autoReleaseThreshold: next } })
      .where(eq(tenants.id, ctx.tenantId));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'automation.threshold_changed',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: { scope: 'company', from: before, to: next },
    });
    return { before, changed: true };
  });
  revalidatePath('/settings/automation');
  return res.changed
    ? {
        ok: true,
        message: `Default threshold ${label(res.before)} → ${label(next)}. Applies to claims scrubbed from now on.`,
      }
    : { ok: true, message: 'Nothing to save.' };
}

/** A client's own threshold, or null to follow the company default. */
export async function saveClientThreshold(
  clientId: string,
  value: number | null,
): Promise<AutomationActionResult> {
  const ctx = await requireActiveContext();
  const id = z.uuid().parse(clientId);
  policy.assertAllowed(ctx.actor, 'automation.manage', { clientId: id });
  const next = value === null ? null : Threshold.parse(value);
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx
      .select({ name: clients.name, threshold: clients.autoReleaseThreshold })
      .from(clients)
      .where(eq(clients.id, id))
      .for('update');
    if (!c) return null;
    if (c.threshold === next) return { name: c.name, changed: false };
    await tx.update(clients).set({ autoReleaseThreshold: next }).where(eq(clients.id, id));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'automation.threshold_changed',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: { scope: 'client', from: c.threshold ?? 'default', to: next ?? 'default' },
    });
    return { name: c.name, changed: true };
  });
  if (!res) return { ok: false, message: 'That client is not in this company.' };
  revalidatePath('/settings/automation');
  if (!res.changed) return { ok: true, message: 'Nothing to save.' };
  return {
    ok: true,
    message:
      next === null
        ? `${res.name} now follows the company default.`
        : `${res.name}: ${label(next)}. Applies to claims scrubbed from now on.`,
  };
}
