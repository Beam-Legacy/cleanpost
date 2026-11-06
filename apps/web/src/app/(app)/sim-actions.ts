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
import { connections, readDemoHistory, recordAudit, setDemoOffset, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { sendClaimStatusSweep, sendDemoWorkday, sendSyncPull } from '@cleanpost/jobs';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import {
  advanceSimClock,
  enterVisits,
  runClearinghouse,
  setPracticeLoginExpired,
  simConfig,
  simNow,
} from '@/lib/sim';

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
  const history = await readDemoHistory(getDb());
  if (history.state === 'pending' || history.state === 'running')
    return { ok: false, message: 'Demo history is being built; the clock moves on its own until today.' };
  // Send what is queued at today's simulated date, with the PM's billing batch. Then day by day, as
  // the demo history does (DEC-19): each weekday the practices enter that day's visits (the PM takes
  // none dated ahead of its own today) and the clock moves a day. The syncs below build the visits
  // into the new day's reviews, blocks and eligibility issues; a PM with no hold bills them at the
  // next press, after Cleanpost has seen them, as its 6 pm batch would after the day's syncs.
  await runClearinghouse(config, { bill: true });
  const practiceIds = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ settings: connections.settings })
      .from(connections)
      .where(and(eq(connections.adapterKey, 'mock'), inArray(connections.status, ['healthy', 'degraded']))),
  ).then((rows) =>
    rows.map((r) => (r.settings as { practiceId?: string }).practiceId).filter((id): id is string => !!id),
  );
  let visits = 0;
  let now = await simNow(config);
  for (let i = 0; i < days; i++) {
    if (now) {
      const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6)
        for (const practiceId of practiceIds) visits += await enterVisits(config, practiceId, day);
    }
    now = await advanceSimClock(config, 1);
  }
  if (!now) return { ok: false, message: 'The payer simulator did not answer. Try again in a moment.' };
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
      metadata: { days, clearinghouse: ran, syncs: rows.length, followed, visits },
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
  // The simulated team works the day and the practices enter the skipped days' visits (DEC-19).
  if (followed) await sendDemoWorkday(boss, { days });
  revalidatePath('/', 'layout');
  const day = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
  return {
    ok: true,
    message: `Demo date is now ${day}. ${ran ? 'The clearinghouse ran; ' : ''}syncing ${conns.length} ${conns.length === 1 ? 'practice' : 'practices'}${visits ? ` with ${visits} new visits` : ''}; then the team works the queue. Refresh in a minute or two.${followed ? '' : ' Cleanpost stays on today: run the seed to turn demo time on.'}`,
    ...(followed ? { offsetMs } : {}),
  };
}

/**
 * Demo (preview and local, docs/18): expire the mock PM's login behind a connection, or restore it,
 * then sync at once so the connection fails (or recovers) in front of the audience. A failed
 * connection opens its work item and admins are told within seconds (DEC-28). Admins only; audited.
 */
export async function simulateLoginProblem(connectionId: string, expired: boolean): Promise<SimResult> {
  const config = simConfig();
  if (!config) return { ok: false, message: 'Demo tools are only available in preview.' };
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed)
    return { ok: false, message: 'Only admins can simulate a connection problem.' };
  const id = z.uuid().parse(connectionId);
  const conn = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.id, id));
    return c ?? null;
  });
  const practiceId = ((conn?.settings ?? {}) as { practiceId?: string }).practiceId;
  if (!conn || conn.adapterKey !== 'mock' || !practiceId)
    return { ok: false, message: 'Only connections to the mock PM can be broken for a demo.' };
  if (!(await setPracticeLoginExpired(config, practiceId, expired)))
    return { ok: false, message: 'The mock PM did not answer. Try again in a moment.' };
  await sendSyncPull(await getBoss(), {
    tenantId: ctx.tenantId,
    connectionId: id,
    trigger: 'manual',
    userId: ctx.user.id,
  });
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: expired ? 'sim.login_expired' : 'sim.login_restored',
      entityType: 'connection',
      entityId: id,
      clientId: conn.clientId,
    }),
  );
  revalidatePath(`/integrations/${id}`);
  return {
    ok: true,
    message: expired
      ? 'The PM login is expired. The sync running now fails, and admins are told in a few seconds.'
      : 'The PM login works again. The sync running now brings the connection back.',
  };
}
