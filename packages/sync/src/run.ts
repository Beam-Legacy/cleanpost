/**
 * One sync cycle for one connection (`sync.pull`, docs/01-architecture.md): ask the adapter what it
 * can do, run each automatic pull page by page into the canonical tables, record a sync run per
 * operation, then move the connection through its state machine. HTTP calls never happen inside a
 * database transaction; each page is written in its own tenant transaction, so a failure part way
 * keeps the pages already written and the next cycle picks up from the same `since`.
 *
 * M1 pulls patients and charges. Claim status (M2), remittances and postings (M3) join this list
 * with the code that applies them.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  AdapterError,
  defaultSyncMinutes,
  PULL_SCHEMAS,
  type AdapterRegistry,
  type CapabilityMap,
  type Connection,
  type ExtClaimStatus,
  type ExtEncounter,
  type ExtPatient,
  type ExtRemittance,
  type Operation,
  type Page,
  type PmAdapter,
} from '@cleanpost/adapters';
import {
  connections,
  recordAudit,
  syncRuns,
  withTenant,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { loadPayerMatcher, type PayerMatcher } from './payers';
import { applyConnectionEvent, lockConnection, type ConnectionRow, type FailureReason } from './state';
import {
  addCounts,
  emptyCounts,
  upsertEncounters,
  upsertPatients,
  type Counts,
  type Rejected,
} from './upsert';

/** Pulls sync always runs. Claim status joins when an applier is given (packages/claims). */
export const SYNC_OPERATIONS = ['pullPatientsAndCoverage', 'pullCharges'] as const;
export type SyncOperation = (typeof SYNC_OPERATIONS)[number] | 'pullClaimsAndStatus' | 'pullRemittances';

/**
 * Appliers for pulls whose records belong to another package, so sync does not depend on it.
 * Each runs inside the page's tenant transaction.
 */
export interface SyncAppliers {
  pullClaimsAndStatus?: (
    tx: Tx,
    ctx: { tenantId: string; clientId: string; connectionId: string; actor: AuditActor },
    items: ExtClaimStatus[],
  ) => Promise<Counts>;
  /** 835s the PM holds (Modes A and C), ingested by packages/remit. */
  pullRemittances?: (
    tx: Tx,
    ctx: { tenantId: string; clientId: string; connectionId: string; actor: AuditActor },
    items: ExtRemittance[],
  ) => Promise<Counts>;
}

export interface SyncDeps {
  db: Database;
  registry: AdapterRegistry;
  log: Logger;
  now?: () => Date;
  /** Waits before each retry of a retryable PM error. Default [1000, 3000]. */
  retryDelaysMs?: number[];
  /** How far back the first charges pull reaches. Default 120 days. */
  backfillDays?: number;
  appliers?: SyncAppliers;
}

export interface SyncRequest {
  tenantId: string;
  connectionId: string;
  trigger: 'schedule' | 'manual';
  /** Who pressed Run now, for the audit trail. */
  userId?: string;
}

export interface OperationOutcome {
  operation: SyncOperation;
  ok: boolean;
  authFailed?: boolean;
  counts: Counts;
  errorCode?: string;
  errorMessage?: string;
}

export type SyncResult =
  | {
      status: 'skipped';
      reason: 'not_found' | 'paused' | 'failed' | 'setup' | 'running' | 'no_automatic_pulls';
    }
  | {
      status: 'done';
      clientId: string;
      connectionStatus: state.ConnectionState;
      operations: OperationOutcome[];
    };

const OVERLAP_MS = 10 * 60_000;
const INTERRUPTED_AFTER_MS = 15 * 60_000;
const FULL_BACKFILL = new Date('2000-01-01T00:00:00Z');
const MAX_PAGES = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function toAdapterConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    adapterKey: row.adapterKey as Connection['adapterKey'],
    credentialsSecretRef: row.credentialsSecretRef,
    pmAccountRef: row.pmAccountRef,
    settings: (row.settings ?? {}) as Record<string, unknown>,
  };
}

/** The interval a connection syncs on: its own override, else the adapter's default. */
export function syncIntervalMinutes(row: Pick<ConnectionRow, 'syncIntervalMinutes' | 'adapterKey'>) {
  return row.syncIntervalMinutes ?? defaultSyncMinutes(row.adapterKey);
}

/** Operations that run on a schedule: automatic (level 1, 2 or 4). File pulls (3) run on upload. */
export function automaticPulls(caps: Partial<CapabilityMap>, appliers: SyncAppliers = {}): SyncOperation[] {
  const ops: SyncOperation[] = [
    ...SYNC_OPERATIONS,
    ...(appliers.pullClaimsAndStatus ? (['pullClaimsAndStatus'] as const) : []),
    ...(appliers.pullRemittances ? (['pullRemittances'] as const) : []),
  ];
  return ops.filter((op) => {
    const level = caps[op];
    return typeof level === 'number' && level > 0 && level !== 3;
  });
}

function describeRejected(rejected: Rejected[]): string | null {
  if (rejected.length === 0) return null;
  const sample = rejected
    .slice(0, 5)
    .map((r) => `${r.externalId ?? 'unknown record'} (${r.field})`)
    .join(', ');
  return `${rejected.length} record${rejected.length === 1 ? '' : 's'} could not be read: ${sample}${rejected.length > 5 ? ', …' : ''}`;
}

async function withRetry<T>(fn: () => Promise<T>, delays: number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof AdapterError && err.retryable;
      if (!retryable || attempt >= delays.length) throw err;
      await sleep(delays[attempt]!);
    }
  }
}

async function runOperation(
  deps: SyncDeps,
  conn: ConnectionRow,
  adapter: PmAdapter,
  op: SyncOperation,
  actor: AuditActor,
): Promise<OperationOutcome> {
  const now = deps.now ?? (() => new Date());
  const ctxTenant = { tenantId: conn.tenantId };
  const { runId, since } = await withTenant(deps.db, ctxTenant, async (tx) => {
    const [last] = await tx
      .select({ startedAt: syncRuns.startedAt })
      .from(syncRuns)
      .where(
        and(eq(syncRuns.connectionId, conn.id), eq(syncRuns.operation, op), eq(syncRuns.status, 'succeeded')),
      )
      .orderBy(desc(syncRuns.startedAt))
      .limit(1);
    const [run] = await tx
      .insert(syncRuns)
      .values({
        tenantId: conn.tenantId,
        clientId: conn.clientId,
        connectionId: conn.id,
        operation: op,
        startedAt: now(),
      })
      .returning({ id: syncRuns.id });
    const backfill =
      op === 'pullPatientsAndCoverage'
        ? FULL_BACKFILL
        : new Date(now().getTime() - (deps.backfillDays ?? 120) * 86_400_000);
    return {
      runId: run!.id,
      since: last ? new Date(last.startedAt.getTime() - OVERLAP_MS) : backfill,
    };
  });

  const ac = toAdapterConnection(conn);
  const delays = deps.retryDelaysMs ?? [1_000, 3_000];
  const ctx = {
    tenantId: conn.tenantId,
    clientId: conn.clientId,
    connectionId: conn.id,
    syncRunId: runId,
    actor,
  };
  let counts = emptyCounts();
  const rejected: Rejected[] = [];
  let payers: PayerMatcher | undefined;

  const finish = (values: Partial<typeof syncRuns.$inferInsert>) =>
    withTenant(deps.db, ctxTenant, (tx) =>
      tx
        .update(syncRuns)
        .set({ ...values, counts, finishedAt: now(), updatedAt: now() })
        .where(eq(syncRuns.id, runId)),
    );

  try {
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES)
        throw new AdapterError('UPSTREAM_ERROR', false, 'The PM kept returning more pages');
      const pull = (): Promise<Page<unknown>> =>
        op === 'pullPatientsAndCoverage'
          ? adapter.pullPatientsAndCoverage(ac, since, cursor)
          : op === 'pullClaimsAndStatus'
            ? adapter.pullClaimsAndStatus(ac, since, cursor)
            : op === 'pullRemittances'
              ? adapter.pullRemittances(ac, since, cursor)
              : adapter.pullCharges(ac, since, cursor);
      const page = await withRetry(pull, delays);
      const valid: unknown[] = [];
      for (const item of page.items) {
        const parsed = PULL_SCHEMAS[op].safeParse(item);
        if (parsed.success) valid.push(parsed.data);
        else {
          const id = (item as { externalId?: unknown } | null)?.externalId;
          rejected.push({
            externalId: typeof id === 'string' ? id : null,
            field: parsed.error.issues[0]?.path.join('.') || 'record',
          });
          counts.failed++;
        }
      }
      for (const r of page.rejected ?? []) {
        rejected.push(r);
        counts.failed++;
      }
      if (valid.length) {
        const pageCounts = await withTenant(deps.db, ctxTenant, async (tx) => {
          payers ??= await loadPayerMatcher(tx, conn.clientId);
          if (op === 'pullPatientsAndCoverage') return upsertPatients(tx, ctx, valid as ExtPatient[], payers);
          if (op === 'pullClaimsAndStatus') {
            return deps.appliers!.pullClaimsAndStatus!(tx, ctx, valid as ExtClaimStatus[]);
          }
          if (op === 'pullRemittances') {
            return deps.appliers!.pullRemittances!(tx, ctx, valid as ExtRemittance[]);
          }
          const res = await upsertEncounters(tx, ctx, valid as ExtEncounter[]);
          rejected.push(...res.rejected);
          return res.counts;
        });
        counts = addCounts(counts, pageCounts);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    await finish({ status: 'succeeded', errorDetail: describeRejected(rejected) });
    return { operation: op, ok: true, counts };
  } catch (err) {
    const e =
      err instanceof AdapterError
        ? err
        : new AdapterError('UPSTREAM_ERROR', true, 'The sync stopped unexpectedly');
    if (!(err instanceof AdapterError))
      deps.log.error({ err, syncRunId: runId, operation: op }, 'sync operation crashed');
    await finish({ status: 'failed', errorCode: e.code, errorDetail: e.message });
    return {
      operation: op,
      ok: false,
      authFailed: e.code === 'AUTH_FAILED',
      counts,
      errorCode: e.code,
      errorMessage: e.message,
    };
  }
}

export async function runSync(deps: SyncDeps, req: SyncRequest): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const actor: AuditActor = req.userId ? `user:${req.userId}` : 'automation:sync.pull';
  const ctxTenant = { tenantId: req.tenantId };

  const loaded = await withTenant(deps.db, ctxTenant, async (tx) => {
    const [conn] = await tx.select().from(connections).where(eq(connections.id, req.connectionId));
    if (!conn) return null;
    // A worker that died mid-run leaves a run "running"; close it so the connection can sync again.
    await tx
      .update(syncRuns)
      .set({
        status: 'failed',
        finishedAt: now(),
        errorCode: 'INTERRUPTED',
        errorDetail: 'The sync stopped before it finished',
      })
      .where(
        and(
          eq(syncRuns.connectionId, conn.id),
          eq(syncRuns.status, 'running'),
          lt(syncRuns.startedAt, new Date(now().getTime() - INTERRUPTED_AFTER_MS)),
        ),
      );
    const running = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(syncRuns)
      .where(and(eq(syncRuns.connectionId, conn.id), eq(syncRuns.status, 'running')));
    return { conn, running: (running[0]?.n ?? 0) > 0 };
  });
  if (!loaded) return { status: 'skipped', reason: 'not_found' };
  const { conn } = loaded;
  if (conn.status === 'paused') return { status: 'skipped', reason: 'paused' };
  if (conn.status === 'setup') return { status: 'skipped', reason: 'setup' };
  if (conn.status === 'failed' && req.trigger === 'schedule') return { status: 'skipped', reason: 'failed' };
  if (loaded.running) return { status: 'skipped', reason: 'running' };

  const adapter = deps.registry.get(conn.adapterKey);
  const ac = toAdapterConnection(conn);
  // If the PM cannot be asked, keep the levels we know; the pulls then fail with the real error.
  const caps = await adapter.capabilities(ac).catch(() => conn.levels as CapabilityMap);
  if (JSON.stringify(caps) !== JSON.stringify(conn.levels)) {
    await withTenant(deps.db, ctxTenant, async (tx) => {
      await tx.update(connections).set({ levels: caps, updatedAt: now() }).where(eq(connections.id, conn.id));
      await recordAudit(tx, {
        actor,
        action: 'connection.levels_updated',
        entityType: 'connection',
        entityId: conn.id,
        clientId: conn.clientId,
      });
    });
  }
  const ops = automaticPulls(caps, deps.appliers);
  if (ops.length === 0) return { status: 'skipped', reason: 'no_automatic_pulls' };

  if (req.userId) {
    await withTenant(deps.db, { tenantId: req.tenantId, userId: req.userId }, (tx) =>
      recordAudit(tx, {
        actor,
        action: 'connection.sync_started',
        entityType: 'connection',
        entityId: conn.id,
        clientId: conn.clientId,
      }),
    );
  }

  const outcomes: OperationOutcome[] = [];
  for (const op of ops) {
    const outcome = await runOperation(deps, conn, adapter, op as Operation & SyncOperation, actor);
    outcomes.push(outcome);
    if (outcome.authFailed) break; // the rest would fail the same way
  }

  const connectionStatus = await withTenant(deps.db, ctxTenant, async (tx) => {
    const current = await lockConnection(tx, conn.id);
    if (!current) return conn.status as state.ConnectionState;
    const event = state.connectionEventAfterSync({
      outcomes: outcomes.map((o) => ({ ok: o.ok, authFailed: o.authFailed })),
      consecutiveFailedCycles: current.consecutiveFailedCycles,
    });
    const allFailed = outcomes.every((o) => !o.ok);
    const firstFailure = outcomes.find((o) => !o.ok);
    const reason: FailureReason | undefined = firstFailure
      ? {
          code: firstFailure.errorCode ?? 'UPSTREAM_ERROR',
          message: firstFailure.errorMessage ?? 'A sync failed.',
        }
      : undefined;
    const interval = syncIntervalMinutes(current);
    const res = await applyConnectionEvent(tx, current, event, {
      actor,
      now: now(),
      ...(reason ? { reason } : {}),
      set: {
        consecutiveFailedCycles: allFailed ? current.consecutiveFailedCycles + 1 : 0,
        ...(firstFailure ? {} : { lastSuccessAt: now() }),
        nextRunAt: interval ? new Date(now().getTime() + interval * 60_000) : null,
      },
    });
    return res.to;
  });

  deps.log.info(
    {
      connectionId: conn.id,
      trigger: req.trigger,
      connectionStatus,
      operations: outcomes.map((o) => ({ op: o.operation, ok: o.ok, code: o.errorCode, ...o.counts })),
    },
    'sync cycle finished',
  );
  return { status: 'done', clientId: conn.clientId, connectionStatus, operations: outcomes };
}
