/**
 * Job handlers. Thin: each validates its payload and calls the sync package (CLAUDE.md: jobs are
 * thin). Payloads carry IDs only.
 */
import {
  createDevSecretResolver,
  createRegistry,
  memoryFileSource,
  type AdapterRegistry,
} from '@cleanpost/adapters';
import { withTenant, workItems, recordAudit, type Database } from '@cleanpost/db';
import { JOBS, sendSyncPull, syncPullPayload, type PgBoss } from '@cleanpost/jobs';
import type { Logger } from '@cleanpost/log';
import {
  createPgRateLimiter,
  listCandidates,
  markStale,
  planTick,
  runSync,
  type SyncDeps,
} from '@cleanpost/sync';

export interface WorkerDeps {
  db: Database;
  boss: PgBoss;
  log: Logger;
  registry: AdapterRegistry;
  now?: () => Date;
  retryDelaysMs?: number[];
}

export function buildRegistry(opts: {
  db: Database;
  pmMock?: { url: string; secret: string; fetch?: typeof fetch };
}): AdapterRegistry {
  return createRegistry({
    // Uploaded files arrive with object storage in M3.
    fileSource: memoryFileSource({}),
    ...(opts.pmMock
      ? {
          mock: {
            baseUrl: opts.pmMock.url,
            secrets: createDevSecretResolver({ pmMockSecret: opts.pmMock.secret }),
            limiter: createPgRateLimiter(opts.db),
            ...(opts.pmMock.fetch ? { fetch: opts.pmMock.fetch } : {}),
          },
        }
      : {}),
  });
}

const syncDeps = (deps: WorkerDeps): SyncDeps => ({
  db: deps.db,
  registry: deps.registry,
  log: deps.log,
  ...(deps.now ? { now: deps.now } : {}),
  ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
});

export async function handleSyncPull(deps: WorkerDeps, data: unknown) {
  const payload = syncPullPayload.parse(data);
  return runSync(syncDeps(deps), payload);
}

/** Every minute: queue connections that are due, and mark stale ones degraded. */
export async function handleTick(deps: WorkerDeps) {
  const now = deps.now?.() ?? new Date();
  const plan = planTick(await listCandidates(deps.db), now);
  let queued = 0;
  for (const c of plan.due) {
    const id = await sendSyncPull(deps.boss, {
      tenantId: c.tenantId,
      connectionId: c.connectionId,
      trigger: 'schedule',
    });
    if (id) queued++;
  }
  for (const c of plan.stale) await markStale(deps.db, c, now);
  if (plan.due.length || plan.stale.length) {
    deps.log.info({ due: plan.due.length, queued, stale: plan.stale.length }, 'sync tick');
  }
  return { due: plan.due.length, queued, stale: plan.stale.length };
}

/**
 * A job that failed after its last retry (docs/01-architecture.md): a `system` work item for the
 * tenant's admins, and an error log line for the platform operator. IDs only.
 */
export async function handleDeadLetter(deps: WorkerDeps, data: unknown, jobName = JOBS.syncPull) {
  const payload = syncPullPayload.safeParse(data);
  deps.log.error(
    { job: jobName, ...(payload.success ? { connectionId: payload.data.connectionId } : {}) },
    'job failed after retries',
  );
  if (!payload.success) return;
  const now = deps.now?.() ?? new Date();
  await withTenant(deps.db, { tenantId: payload.data.tenantId }, async (tx) => {
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId: payload.data.tenantId,
        type: 'system',
        priority: 1,
        dueAt: new Date(now.getTime() + 4 * 3_600_000),
        connectionId: payload.data.connectionId,
        reasonCode: 'JOB_FAILED',
        summary: 'A sync job failed after 5 attempts. Cleanpost support has been alerted.',
      })
      .returning({ id: workItems.id });
    await recordAudit(tx, {
      actor: 'system',
      action: 'work_item.created',
      entityType: 'work_item',
      entityId: item!.id,
      metadata: { type: 'system', job: jobName, connectionId: payload.data.connectionId },
    });
  });
}

/** Registers every handler and the tick schedule on a started pg-boss. */
export async function registerWorkers(
  deps: WorkerDeps,
  opts: { concurrency?: number; schedule?: boolean } = {},
) {
  await deps.boss.work(
    JOBS.syncPull,
    { batchSize: 1, localConcurrency: opts.concurrency ?? 4 },
    async ([job]) => {
      if (job) await handleSyncPull(deps, job.data);
    },
  );
  await deps.boss.work(JOBS.syncTick, async () => {
    await handleTick(deps);
  });
  await deps.boss.work(JOBS.deadLetter, async ([job]) => {
    if (job) await handleDeadLetter(deps, job.data);
  });
  if (opts.schedule ?? true) await deps.boss.schedule(JOBS.syncTick, '* * * * *');
}
