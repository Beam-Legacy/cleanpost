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
  applyClaimStatuses,
  buildClaimsForClient,
  checkClaimStatus,
  statusSweep,
  holdCharges,
  pushCorrection,
  releaseClaim,
  scrubVersion,
  versionsAwaitingScrub,
  type ClaimReviewer,
} from '@cleanpost/claims';
import { eq, inArray } from 'drizzle-orm';
import type { ExtRemittance } from '@cleanpost/adapters';
import { fromExtRemittance, ingestInTx, storePmPostings, verifyInTx } from '@cleanpost/remit';
import { parse835 } from '@cleanpost/x12';
import {
  claims,
  claimVersions,
  recordAudit,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import {
  checkCoverage,
  coveragesNeedingCheck,
  versionsWaitingOnCoverage,
  type ClaimStatusClient,
  type EligibilityClient,
} from '@cleanpost/eligibility';
import {
  claimBuildPayload,
  claimCorrectPayload,
  claimReleasePayload,
  claimStatusCheckPayload,
  eligibilityCheckPayload,
  claimScrubPayload,
  JOBS,
  sendClaimBuild,
  sendClaimRelease,
  sendClaimScrub,
  sendClaimStatusCheck,
  sendEligibilityCheck,
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
import { now as clockNow } from '@cleanpost/clock';

export interface WorkerDeps {
  db: Database;
  boss: PgBoss;
  log: Logger;
  registry: AdapterRegistry;
  /** Step 8 of the scrub (AI review); scrubs run without it when absent. */
  reviewer?: ClaimReviewer;
  /** Stedi 270/271 (payer-sim in local and preview); scrubs read no check when absent. */
  eligibility?: EligibilityClient;
  /** Stedi 276/277 (payer-sim in local and preview); follow-ups open without checks when absent. */
  claimStatus?: ClaimStatusClient;
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

/** Each remittance the PM holds: its own 835 when it has one, else the PM's structured copy. */
async function applyRemittances(
  tx: Tx,
  ctx: { tenantId: string; clientId: string; connectionId: string; actor: AuditActor },
  items: ExtRemittance[],
) {
  const counts = { new: 0, changed: 0, unchanged: 0, failed: 0 };
  for (const item of items) {
    const r = item.raw835 ? parse835(item.raw835) : fromExtRemittance(item);
    const res = await ingestInTx(
      tx,
      { tenantId: ctx.tenantId, clientId: ctx.clientId, source: 'pm' },
      r,
      clockNow(),
    );
    if (res.status === 'duplicate') counts.unchanged++;
    else counts.new++;
  }
  return counts;
}

const syncDeps = (deps: WorkerDeps): SyncDeps => ({
  db: deps.db,
  registry: deps.registry,
  log: deps.log,
  ...(deps.now ? { now: deps.now } : {}),
  ...(deps.retryDelaysMs ? { retryDelaysMs: deps.retryDelaysMs } : {}),
  // Claim status from the PM is applied to claims (Mode A tracking, docs/04); the 835s the PM
  // holds are ingested and matched, its postings stored, and every matched payment checked
  // against what the PM posted (docs/07 posting match).
  appliers: {
    pullClaimsAndStatus: applyClaimStatuses,
    pullRemittances: applyRemittances,
    pullPostings: async (tx, ctx, items) => {
      const r = await storePmPostings(tx, ctx, items);
      return { new: r.created, changed: 0, unchanged: r.unchanged, failed: 0 };
    },
    afterPulls: (tx, ctx, now) => verifyInTx(tx, { tenantId: ctx.tenantId, clientId: ctx.clientId }, now),
  },
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
  // New charges are held in the PM so nothing bills before the scrub (docs/04 Mode A).
  const held = await holdCharges(releaseDeps(deps), {
    tenantId: payload.tenantId,
    claimIds: result.createdClaimIds,
  });
  // Every built version waits for a scrub, including any a crashed worker left behind. Where the
  // coverage has no recent eligibility check, the check runs first and queues the scrub (step 2).
  const awaiting = await versionsAwaitingScrub(deps.db, payload.tenantId, payload.clientId);
  const versions = [...new Set([...result.toScrub, ...awaiting])];
  const waiting = deps.eligibility
    ? await waitForEligibility(deps, payload.tenantId, versions)
    : new Set<string>();
  for (const claimVersionId of versions) {
    if (!waiting.has(claimVersionId))
      await sendClaimScrub(deps.boss, { tenantId: payload.tenantId, claimVersionId });
  }
  // Claims that waited for a correction in the PM go once the PM shows it.
  for (const claimId of result.toRelease) {
    await sendClaimRelease(deps.boss, { tenantId: payload.tenantId, claimId });
  }
  deps.log.info(
    {
      clientId: payload.clientId,
      created: result.created,
      updated: result.updated,
      toScrub: awaiting.length,
      held: held.held,
      toRelease: result.toRelease.length,
    },
    'claims built',
  );
  return result;
}

export async function handleClaimScrub(deps: WorkerDeps, data: unknown) {
  const payload = claimScrubPayload.parse(data);
  const result = await scrubVersion(
    {
      db: deps.db,
      log: deps.log,
      ...(deps.reviewer ? { reviewer: deps.reviewer } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    payload,
  );
  // At or above the threshold with nothing blocking: released without a human (docs/04 step 5).
  if (result.status === 'scrubbed' && result.decision === 'auto_release') {
    const claimId = await claimOfVersion(deps.db, payload.tenantId, payload.claimVersionId);
    if (claimId) await sendClaimRelease(deps.boss, { tenantId: payload.tenantId, claimId });
  }
  return result;
}

/**
 * Queues an eligibility check for each coverage among these versions that has none in the last
 * 7 days; returns the versions that now wait for it (the check queues their scrub).
 */
async function waitForEligibility(deps: WorkerDeps, tenantId: string, versionIds: string[]) {
  if (!versionIds.length) return new Set<string>();
  const now = deps.now?.() ?? clockNow();
  const { byCoverage, due } = await withTenant(deps.db, { tenantId }, async (tx) => {
    const rows = await tx
      .select({ versionId: claimVersions.id, coverageId: claims.coverageId })
      .from(claimVersions)
      .innerJoin(claims, eq(claims.id, claimVersions.claimId))
      .where(inArray(claimVersions.id, versionIds));
    const byCoverage = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.coverageId) continue;
      byCoverage.set(r.coverageId, [...(byCoverage.get(r.coverageId) ?? []), r.versionId]);
    }
    return { byCoverage, due: await coveragesNeedingCheck(tx, [...byCoverage.keys()], now) };
  });
  const waiting = new Set<string>();
  for (const coverageId of due) {
    await sendEligibilityCheck(deps.boss, { tenantId, coverageId });
    for (const v of byCoverage.get(coverageId) ?? []) waiting.add(v);
  }
  return waiting;
}

/** eligibility.check: store the 271 summary, then scrub the claims that waited for it. */
export async function handleEligibilityCheck(deps: WorkerDeps, data: unknown) {
  const payload = eligibilityCheckPayload.parse(data);
  const result = deps.eligibility
    ? await checkCoverage(
        { db: deps.db, client: deps.eligibility, log: deps.log, ...(deps.now ? { now: deps.now } : {}) },
        payload,
      )
    : ({ status: 'skipped', reason: 'not_found' } as const);
  // A payer that is down is retried with backoff; after the last attempt the scrub goes on without it.
  if (result.status === 'failed' && result.retryable)
    throw new Error(`eligibility check failed: ${result.code}`);
  await scrubWaiting(deps, payload);
  return result;
}

async function scrubWaiting(deps: WorkerDeps, p: { tenantId: string; coverageId: string }) {
  for (const claimVersionId of await versionsWaitingOnCoverage(deps.db, p.tenantId, p.coverageId)) {
    await sendClaimScrub(deps.boss, { tenantId: p.tenantId, claimVersionId });
  }
}

const releaseDeps = (deps: WorkerDeps) => ({
  db: deps.db,
  registry: deps.registry,
  log: deps.log,
  ...(deps.now ? { now: deps.now } : {}),
});

async function claimOfVersion(db: Database, tenantId: string, claimVersionId: string) {
  return withTenant(db, { tenantId }, async (tx) => {
    const [v] = await tx
      .select({ claimId: claimVersions.claimId })
      .from(claimVersions)
      .where(eq(claimVersions.id, claimVersionId));
    return v?.claimId ?? null;
  });
}

export async function handleClaimRelease(deps: WorkerDeps, data: unknown) {
  const payload = claimReleasePayload.parse(data);
  const result = await releaseClaim(
    releaseDeps(deps),
    { tenantId: payload.tenantId, claimId: payload.claimId },
    payload.userId ? `user:${payload.userId}` : 'automation:claim.release',
  );
  // A retryable PM error is thrown so the queue retries with backoff, then dead-letters.
  if (result.status === 'failed' && result.retryable) throw new Error(`release failed: ${result.code}`);
  deps.log.info({ claimId: payload.claimId, status: result.status }, 'claim release');
  return result;
}

/** Mode A: write a person's edit to the PM, or give the biller a correction task (docs/04). */
export async function handleClaimCorrect(deps: WorkerDeps, data: unknown) {
  const payload = claimCorrectPayload.parse(data);
  const result = await pushCorrection(releaseDeps(deps), payload);
  deps.log.info({ claimId: payload.claimId, status: result.status }, 'claim correction');
  return result;
}

/**
 * A 276 for one claim (C-15, W-15). A payer that does not answer is asked again at the next sweep,
 * so a failure is logged, not retried here (no dead letters for a slow payer).
 */
export async function handleClaimStatusCheck(deps: WorkerDeps, data: unknown) {
  const payload = claimStatusCheckPayload.parse(data);
  if (!deps.claimStatus) return { status: 'skipped' as const };
  const res = await checkClaimStatus(
    { db: deps.db, client: deps.claimStatus, log: deps.log, ...(deps.now ? { now: deps.now } : {}) },
    { tenantId: payload.tenantId, claimId: payload.claimId, trigger: payload.trigger },
  );
  deps.log.info(
    { claimId: payload.claimId, status: res.status, ...(res.status === 'checked' ? { kind: res.kind } : {}) },
    'claim status check',
  );
  return res;
}

/** Daily (docs/04-modes.md): follow-ups for claims the payer has not answered, and their checks. */
export async function handleStatusSweep(deps: WorkerDeps) {
  const now = deps.now?.() ?? clockNow();
  const tenants = [...new Set((await listCandidates(deps.db)).map((c) => c.tenantId))];
  let opened = 0;
  let queued = 0;
  for (const tenantId of tenants) {
    const res = await statusSweep(deps.db, { tenantId }, now);
    opened += res.opened;
    if (deps.claimStatus)
      for (const claimId of res.due)
        if (await sendClaimStatusCheck(deps.boss, { tenantId, claimId, trigger: 'sweep' })) queued++;
  }
  deps.log.info({ tenants: tenants.length, opened, queued }, 'claim status sweep');
  return { opened, queued };
}

/** Every minute: queue connections that are due, and mark stale ones degraded. */
export async function handleTick(deps: WorkerDeps) {
  const now = deps.now?.() ?? clockNow();
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
  const eligibility = eligibilityCheckPayload.safeParse(data);
  if (eligibility.success) {
    // Claims must not wait for ever on a payer that does not answer: scrub them without a check.
    await scrubWaiting(deps, eligibility.data);
  }
  const correct = claimCorrectPayload.safeParse(data);
  const release = claimReleasePayload.safeParse(data);
  const failed = eligibility.success
    ? {
        job: JOBS.eligibilityCheck,
        tenantId: eligibility.data.tenantId,
        refs: {},
        what: 'An eligibility check',
      }
    : sync.success
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
          : correct.success
            ? {
                job: JOBS.claimCorrect,
                tenantId: correct.data.tenantId,
                refs: { claimId: correct.data.claimId },
                what: 'A claim correction job',
              }
            : release.success
              ? {
                  job: JOBS.claimRelease,
                  tenantId: release.data.tenantId,
                  refs: { claimId: release.data.claimId },
                  what: 'A claim release job',
                }
              : null;
  deps.log.error({ job: failed?.job ?? 'unknown', ...(failed?.refs ?? {}) }, 'job failed after retries');
  if (!failed) return;
  const now = deps.now?.() ?? clockNow();
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
        ...('claimId' in failed.refs ? { claimId: failed.refs.claimId } : {}),
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
  await deps.boss.work(JOBS.claimRelease, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (job) await handleClaimRelease(deps, job.data);
  });
  await deps.boss.work(JOBS.claimCorrect, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (job) await handleClaimCorrect(deps, job.data);
  });
  await deps.boss.work(JOBS.eligibilityCheck, { batchSize: 1, localConcurrency: 4 }, async ([job]) => {
    if (job) await handleEligibilityCheck(deps, job.data);
  });
  await deps.boss.work(JOBS.claimStatusCheck, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (job) await handleClaimStatusCheck(deps, job.data);
  });
  await deps.boss.work(JOBS.claimStatusSweep, async () => {
    await handleStatusSweep(deps);
  });
  await deps.boss.work(JOBS.deadLetter, async ([job]) => {
    if (job) await handleDeadLetter(deps, job.data);
  });
  if (opts.schedule ?? true) {
    await deps.boss.schedule(JOBS.syncTick, '* * * * *');
    // Daily at 6:17 am Pacific (13:17 UTC, 14:17 in winter): before the billers start.
    await deps.boss.schedule(JOBS.claimStatusSweep, '17 13 * * *');
  }
}
