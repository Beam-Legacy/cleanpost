'use server';
/**
 * Preview and local only: move the demo clock forward so weeks of acknowledgments and payments
 * arrive in minutes. The payer simulator's clock moves, Cleanpost and the mock PM follow it
 * (DEC-18), then the mock PM's clearinghouse runs and a sync is queued for each mock PM connection.
 * Admins only; audited. IDs only in the jobs.
 */
import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { connections, recordAudit, setDemoOffset, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { sendClaimStatusSweep, sendSyncPull } from '@cleanpost/jobs';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { advanceSimClock, runClearinghouse, simConfig } from '@/lib/sim';

export interface SimResult {
  ok: boolean;
  message: string;
  /** Cleanpost's demo offset after the change, for the browser's clock. */
  offsetMs?: number;
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
  // Cleanpost follows the simulator: claims age, follow-ups come due and payments land on its date.
  const offsetMs = now.getTime() - Date.now();
  const followed = await setDemoOffset(getDb(), offsetMs).then(
    () => true,
    () => false,
  );
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
      metadata: { days, clearinghouse: ran, syncs: rows.length, followed },
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
  // The daily jobs run on the real clock; days skipped at once get their follow-up sweep now.
  if (followed) await sendClaimStatusSweep(boss);
  revalidatePath('/', 'layout');
  const day = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
  return {
    ok: true,
    message: `Demo date is now ${day}. ${ran ? 'The clearinghouse ran; ' : ''}syncing ${conns.length} ${conns.length === 1 ? 'practice' : 'practices'} — refresh in a minute.${followed ? '' : ' Cleanpost stays on today: run the seed to turn demo time on.'}`,
    ...(followed ? { offsetMs } : {}),
  };
}
