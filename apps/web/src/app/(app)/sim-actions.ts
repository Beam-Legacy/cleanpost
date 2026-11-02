'use server';
/**
 * Preview and local only: move the payer simulator's clock forward so weeks of acknowledgments and
 * payments arrive in minutes, then run the mock PM's clearinghouse and queue a sync for each mock
 * PM connection. Admins only; audited. IDs only in the jobs.
 */
import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { connections, recordAudit, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { sendSyncPull } from '@cleanpost/jobs';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { advanceSimClock, runClearinghouse, simConfig } from '@/lib/sim';

export interface SimResult {
  ok: boolean;
  message: string;
}

export async function advanceClock(daysInput: number): Promise<SimResult> {
  const config = simConfig();
  if (!config) return { ok: false, message: 'The payer simulator is only available in preview.' };
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed)
    return { ok: false, message: 'Only admins can move the simulated clock.' };
  const days = z.number().int().min(1).max(30).parse(daysInput);
  // Send what is queued at today's simulated date (with the PM's billing batch), move the clock,
  // then collect the 277CAs and 835s that came due.
  await runClearinghouse(config, { bill: true });
  const now = await advanceSimClock(config, days);
  const ran = await runClearinghouse(config, { bill: false });
  const conns = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.adapterKey, 'mock'), inArray(connections.status, ['healthy', 'degraded'])));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'sim.clock_advanced',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      metadata: { days, clearinghouse: ran, syncs: rows.length },
    });
    return rows;
  });
  const boss = await getBoss();
  for (const c of conns)
    await sendSyncPull(boss, {
      tenantId: ctx.tenantId,
      connectionId: c.id,
      trigger: 'manual',
      userId: ctx.user.id,
    });
  revalidatePath('/remittances');
  revalidatePath('/work');
  const day = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
  return {
    ok: true,
    message: `Simulated date is now ${day}. ${ran ? 'The clearinghouse ran; ' : ''}syncing ${conns.length} ${conns.length === 1 ? 'practice' : 'practices'} — refresh in a minute.`,
  };
}
