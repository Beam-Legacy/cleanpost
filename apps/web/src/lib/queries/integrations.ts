import 'server-only';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { CapabilityMap } from '@cleanpost/adapters';
import { clients, connections, syncRuns, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface ConnectionRow {
  id: string;
  clientId: string;
  clientName: string;
  clientMode: 'A' | 'B' | 'C';
  adapterKey: string;
  pmName: string;
  profile: string | null;
  levels: Partial<CapabilityMap>;
  status: 'setup' | 'testing' | 'healthy' | 'degraded' | 'failed' | 'paused';
  pmAccountRef: string | null;
  syncIntervalMinutes: number | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
  credentialsRotatedAt: Date | null;
  latestError: string | null;
}

const scopeWhere = (ctx: ActiveContext): SQL | undefined => {
  const scope = policy.clientFilter(ctx.actor);
  return scope === 'all'
    ? undefined
    : inArray(clients.id, scope.length ? [...scope] : ['00000000-0000-0000-0000-000000000000']);
};

async function selectConnections(ctx: ActiveContext, extra?: SQL) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({
        c: connections,
        clientName: clients.name,
        clientMode: clients.defaultMode,
      })
      .from(connections)
      .innerJoin(clients, eq(clients.id, connections.clientId))
      .where(and(scopeWhere(ctx), extra));
    const ids = rows.map((r) => r.c.id);
    const failures = ids.length
      ? await tx
          .select({
            connectionId: syncRuns.connectionId,
            detail: syncRuns.errorDetail,
            status: syncRuns.status,
          })
          .from(syncRuns)
          .where(inArray(syncRuns.connectionId, ids))
          .orderBy(desc(syncRuns.startedAt))
          .limit(200)
      : [];
    return rows.map(({ c, clientName, clientMode }): ConnectionRow => {
      const settings = (c.settings ?? {}) as { pmName?: string; profile?: string };
      // Only the most recent run counts: an old failure followed by a success is not a problem.
      const latest = failures.find((f) => f.connectionId === c.id);
      const lastFailure = latest?.status === 'failed' ? latest : undefined;
      return {
        id: c.id,
        clientId: c.clientId,
        clientName,
        clientMode: clientMode as ConnectionRow['clientMode'],
        adapterKey: c.adapterKey,
        pmName: settings.pmName ?? c.adapterKey,
        profile: settings.profile ?? null,
        levels: c.levels as Partial<CapabilityMap>,
        status: c.status as ConnectionRow['status'],
        pmAccountRef: c.pmAccountRef,
        syncIntervalMinutes: c.syncIntervalMinutes,
        lastSuccessAt: c.lastSuccessAt,
        nextRunAt: c.nextRunAt,
        credentialsRotatedAt: c.credentialsRotatedAt,
        latestError: lastFailure?.detail ?? null,
      };
    });
  });
}

/** I-01: every connection in scope, problems first. */
export async function listConnections(ctx: ActiveContext): Promise<ConnectionRow[]> {
  const order = { failed: 0, degraded: 1, setup: 2, testing: 2, paused: 3, healthy: 4 } as const;
  const rows = await selectConnections(ctx);
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.clientName.localeCompare(b.clientName));
}

export async function getConnection(ctx: ActiveContext, id: string): Promise<ConnectionRow | null> {
  const [row] = await selectConnections(ctx, eq(connections.id, id));
  return row ?? null;
}

export interface SyncRunRow {
  id: string;
  operation: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  counts: Record<string, number>;
  errorCode: string | null;
  errorDetail: string | null;
}

/** I-02 recent runs and I-03 detail. Counts and codes only; never record contents. */
export async function listSyncRuns(
  ctx: ActiveContext,
  connectionId: string,
  limit = 50,
): Promise<SyncRunRow[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.connectionId, connectionId))
      .orderBy(desc(syncRuns.startedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      counts: r.counts as Record<string, number>,
      errorCode: r.errorCode,
      errorDetail: r.errorDetail,
    }));
  });
}
