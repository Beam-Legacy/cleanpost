/**
 * Which connections are due (docs/01-architecture.md, `sync.pull` schedule). The cross-tenant list
 * comes from app.sync_candidates(), which returns IDs and schedule fields only; everything else
 * happens inside each connection's tenant.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type AuditActor, type Database } from '@cleanpost/db';
import { syncIntervalMinutes } from './run';
import { applyConnectionEvent, lockConnection } from './state';

export interface Candidate {
  tenantId: string;
  connectionId: string;
  adapterKey: string;
  status: string;
  syncIntervalMinutes: number | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
}

export async function listCandidates(db: Database): Promise<Candidate[]> {
  const res = await db.execute<{
    tenant_id: string;
    connection_id: string;
    adapter_key: string;
    status: string;
    sync_interval_minutes: number | null;
    last_success_at: string | Date | null;
    next_run_at: string | Date | null;
  }>(sql`select * from app.sync_candidates()`);
  const date = (v: string | Date | null) => (v === null ? null : new Date(v));
  return res.rows.map((r) => ({
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    adapterKey: r.adapter_key,
    status: r.status,
    syncIntervalMinutes: r.sync_interval_minutes,
    lastSuccessAt: date(r.last_success_at),
    nextRunAt: date(r.next_run_at),
  }));
}

/** Pure: connections whose next run is due, and healthy ones that have not succeeded for 2x their interval. */
export function planTick(candidates: Candidate[], now: Date) {
  const due: Candidate[] = [];
  const stale: Candidate[] = [];
  for (const c of candidates) {
    const interval = syncIntervalMinutes({
      syncIntervalMinutes: c.syncIntervalMinutes,
      adapterKey: c.adapterKey,
    });
    if (!interval) continue; // on demand or on upload only
    if (!c.nextRunAt || c.nextRunAt <= now) due.push(c);
    if (
      c.status === 'healthy' &&
      c.lastSuccessAt &&
      now.getTime() - c.lastSuccessAt.getTime() > 2 * interval * 60_000
    ) {
      stale.push(c);
    }
  }
  return { due, stale };
}

export async function markStale(db: Database, c: Candidate, now: Date): Promise<void> {
  await withTenant(db, { tenantId: c.tenantId }, async (tx) => {
    const conn = await lockConnection(tx, c.connectionId);
    if (!conn || conn.status !== 'healthy') return;
    await applyConnectionEvent(tx, conn, 'stale', {
      actor: 'automation:sync.schedule',
      now,
      reason: { code: 'STALE', message: 'No successful sync for more than twice the schedule.' },
    });
  });
}

/** I-02 Pause syncing / Resume, by a tenant admin. */
export async function setPaused(
  db: Database,
  ctx: { tenantId: string; userId: string },
  connectionId: string,
  paused: boolean,
): Promise<{ ok: boolean; status: string }> {
  return withTenant(db, ctx, async (tx) => {
    const conn = await lockConnection(tx, connectionId);
    if (!conn) return { ok: false, status: 'not_found' };
    const actor: AuditActor = `user:${ctx.userId}`;
    const res = await applyConnectionEvent(tx, conn, paused ? 'paused' : 'resumed', {
      actor,
      now: new Date(),
      // Resumed connections sync on the next tick.
      ...(paused ? {} : { set: { nextRunAt: null } }),
    });
    return { ok: res.applied, status: res.to };
  });
}
