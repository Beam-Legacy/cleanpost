/**
 * Job handlers. Thin: each validates its payload and calls a package (sync, claims); jobs are thin
 * (CLAUDE.md). Payloads carry IDs only.
 *
 * sync.pull -> claim.build (per client) -> claim.scrub (per claim version)
 */
import {
  createDevSecretResolver,
  createRegistry,
  memoryFileSource,
  type AdapterRegistry,
} from '@cleanpost/adapters';
import {
  buildClaimsForClient,
  scrubVersion,
  versionsAwaitingScrub,
  type ClaimReviewer,
} from '@cleanpost/claims';
import { withTenant, workItems, recordAudit, type Database } from '@cleanpost/db';
import {
  claimBuildPayload,
  claimScrubPayload,
  JOBS,
  sendClaimBuild,
  sendClaimScrub,
  sendSyncPull,
  syncPullPayload,
  type PgBoss,
} from '@cleanpost/jobs';
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
  /** Step 8 of the scrub (AI review); scrubs run without it when absent. */
  reviewer?: ClaimReviewer;
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
  const result = await runSync(syncDeps(deps), payload);
  // New or changed charges become claims (docs/04-modes.md step 3).
  if (result.status === 'done') {
    await sendClaimBuild(deps.boss, { tenantId: payload.tenantId, clientId: result.clientId });
  }
  return result;
}

export async function handleClaimBuild(deps: WorkerDeps, data: unknown) {
  const payload = claimBuildPayload.parse(data);
  const result = await buildClaimsForClient(deps.db, payload, deps.now ? { now: deps.now() } : {});
  // Every built version waits for a scrub, including any a crashed worker left behind.
  const awaiting = await versionsAwaitingScrub(deps.db, payload.tenantId, payload.clientId);
  for (const claimVersionId of new Set([...result.toScrub, ...awaiting])) {
    await sendClaimScrub(deps.boss, { tenantId: payload.tenantId, claimVersionId });
  }
  deps.log.info(
    {
      clientId: payload.clientId,
      created: result.created,
      updated: result.updated,
      toScrub: awaiting.length,
    },
    'claims built',
  );
  return result;
}

export async function handleClaimScrub(deps: WorkerDeps, data: unknown) {
  const payload = claimScrubPayload.parse(data);
  return scrubVersion(
    {
      db: deps.db,
      log: deps.log,
      ...(deps.reviewer ? { reviewer: deps.reviewer } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    payload,
  );
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
export async function handleDeadLetter(deps: WorkerDeps, data: unknown) {
  // The dead-letter queue receives the original payload; its shape says which job it was.
  const sync = syncPullPayload.safeParse(data);
  const build = claimBuildPayload.safeParse(data);
  const scrub = claimScrubPayload.safeParse(data);
  const failed = sync.success
    ? {
        job: JOBS.syncPull,
        tenantId: sync.data.tenantId,
        refs: { connectionId: sync.data.connectionId },
        what: 'A sync job',
      }
    : build.success
      ? {
          job: JOBS.claimBuild,
          tenantId: build.data.tenantId,
          refs: { clientId: build.data.clientId },
          what: 'A claim build job',
        }
      : scrub.success
        ? {
            job: JOBS.claimScrub,
            tenantId: scrub.data.tenantId,
            refs: { claimVersionId: scrub.data.claimVersionId },
            what: 'A claim scrub job',
          }
        : null;
  deps.log.error({ job: failed?.job ?? 'unknown', ...(failed?.refs ?? {}) }, 'job failed after retries');
  if (!failed) return;
  const now = deps.now?.() ?? new Date();
  await withTenant(deps.db, { tenantId: failed.tenantId }, async (tx) => {
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId: failed.tenantId,
        type: 'system',
        priority: 1,
        dueAt: new Date(now.getTime() + 4 * 3_600_000),
        ...('connectionId' in failed.refs ? { connectionId: failed.refs.connectionId } : {}),
        ...('clientId' in failed.refs ? { clientId: failed.refs.clientId } : {}),
        reasonCode: 'JOB_FAILED',
        summary: `${failed.what} failed after 5 attempts. Cleanpost support has been alerted.`,
      })
      .returning({ id: workItems.id });
    await recordAudit(tx, {
      actor: 'system',
      action: 'work_item.created',
      entityType: 'work_item',
      entityId: item!.id,
      metadata: { type: 'system', job: failed.job, ...failed.refs },
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
  await deps.boss.work(JOBS.claimBuild, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (job) await handleClaimBuild(deps, job.data);
  });
  await deps.boss.work(
    JOBS.claimScrub,
    { batchSize: 1, localConcurrency: opts.concurrency ?? 4 },
    async ([job]) => {
      if (job) await handleClaimScrub(deps, job.data);
    },
  );
  await deps.boss.work(JOBS.deadLetter, async ([job]) => {
    if (job) await handleDeadLetter(deps, job.data);
  });
  if (opts.schedule ?? true) await deps.boss.schedule(JOBS.syncTick, '* * * * *');
}
