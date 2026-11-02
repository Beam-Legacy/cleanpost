/**
 * Job queue (pg-boss on Postgres, docs/01-architecture.md). Payloads carry record IDs only
 * (CLAUDE.md rule 2) and are validated with Zod when a job is read.
 *
 * The queue lives in its own `pgboss` schema. The migration role installs it (installJobSchema) and
 * creates the queues; the apps connect as the app role with migrate off. The web app only sends;
 * the worker also runs the schedule and maintenance.
 */
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { z } from 'zod';

export const JOB_SCHEMA = 'pgboss';

export const JOBS = {
  syncPull: 'sync.pull',
  syncTick: 'sync.tick',
  claimBuild: 'claim.build',
  claimScrub: 'claim.scrub',
  claimRelease: 'claim.release',
  claimCorrect: 'claim.correct',
  eligibilityCheck: 'eligibility.check',
  claimStatusCheck: 'claim.statusCheck',
  claimStatusSweep: 'claim.statusSweep',
  deadLetter: 'system.dead_letter',
} as const;

export const claimBuildPayload = z.object({ tenantId: z.uuid(), clientId: z.uuid() });
export type ClaimBuildPayload = z.infer<typeof claimBuildPayload>;

export const claimScrubPayload = z.object({ tenantId: z.uuid(), claimVersionId: z.uuid() });
export type ClaimScrubPayload = z.infer<typeof claimScrubPayload>;

export const claimReleasePayload = z.object({
  tenantId: z.uuid(),
  claimId: z.uuid(),
  /** Who released it (C-11); absent for auto-release. */
  userId: z.uuid().optional(),
});
export type ClaimReleasePayload = z.infer<typeof claimReleasePayload>;

/** Mode A write-back of a person's edit (docs/04-modes.md); versionId is the edit that asked. */
export const claimCorrectPayload = z.object({
  tenantId: z.uuid(),
  claimId: z.uuid(),
  versionId: z.uuid(),
});
export type ClaimCorrectPayload = z.infer<typeof claimCorrectPayload>;

/** Stedi 270/271 for one coverage (docs/01-architecture.md); the claims waiting on it scrub after. */
export const eligibilityCheckPayload = z.object({ tenantId: z.uuid(), coverageId: z.uuid() });
export type EligibilityCheckPayload = z.infer<typeof eligibilityCheckPayload>;

/** A 276 for one claim: from the daily sweep, or an hour after a person's check got no answer. */
export const claimStatusCheckPayload = z.object({
  tenantId: z.uuid(),
  claimId: z.uuid(),
  trigger: z.enum(['sweep', 'retry']),
});
export type ClaimStatusCheckPayload = z.infer<typeof claimStatusCheckPayload>;

const RETRIES = {
  retryLimit: 4,
  retryDelay: 30,
  retryBackoff: true,
  deadLetter: 'system.dead_letter',
} as const;

export const syncPullPayload = z.object({
  tenantId: z.uuid(),
  connectionId: z.uuid(),
  trigger: z.enum(['schedule', 'manual']),
  userId: z.uuid().optional(),
});
export type SyncPullPayload = z.infer<typeof syncPullPayload>;

/** Retry policy (docs/01-architecture.md): exponential backoff, 5 attempts, then the dead-letter queue. */
export const QUEUES: { name: string; options: Parameters<PgBoss['createQueue']>[1] }[] = [
  { name: JOBS.deadLetter, options: { retryLimit: 0, deleteAfterSeconds: 30 * 86_400 } },
  {
    name: JOBS.syncPull,
    // One queued and one running job per connection (singletonKey = connection ID).
    options: {
      policy: 'stately',
      retryLimit: 4,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      deadLetter: JOBS.deadLetter,
    },
  },
  { name: JOBS.syncTick, options: { policy: 'singleton', retryLimit: 0, expireInSeconds: 5 * 60 } },
  // One queued and one running build per client (singletonKey = client ID).
  { name: JOBS.claimBuild, options: { policy: 'stately', expireInSeconds: 30 * 60, ...RETRIES } },
  // One queued release per claim (singletonKey = claim ID).
  { name: JOBS.claimRelease, options: { policy: 'stately', expireInSeconds: 10 * 60, ...RETRIES } },
  // One queued check per coverage (singletonKey = coverage ID).
  { name: JOBS.eligibilityCheck, options: { policy: 'stately', expireInSeconds: 5 * 60, ...RETRIES } },
  // One queued write-back per claim (singletonKey = claim ID); it sends every change still missing.
  { name: JOBS.claimCorrect, options: { policy: 'stately', expireInSeconds: 10 * 60, ...RETRIES } },
  // One queued status check per claim (singletonKey = claim ID); a payer that does not answer is
  // asked again at the next sweep, so no retries pile up.
  { name: JOBS.claimStatusCheck, options: { policy: 'stately', expireInSeconds: 5 * 60, retryLimit: 0 } },
  { name: JOBS.claimStatusSweep, options: { policy: 'singleton', retryLimit: 0, expireInSeconds: 30 * 60 } },
  // One queued scrub per claim version (singletonKey = version ID).
  { name: JOBS.claimScrub, options: { policy: 'stately', expireInSeconds: 10 * 60, ...RETRIES } },
];

export type Role = 'web' | 'worker';

export function createBoss(connectionString: string, role: Role): PgBoss {
  return new PgBoss({
    connectionString,
    schema: JOB_SCHEMA,
    application_name: `cleanpost-${role}`,
    max: role === 'web' ? 2 : 5,
    migrate: false,
    createSchema: false,
    supervise: role === 'worker',
    schedule: role === 'worker',
  });
}

/**
 * Installs or upgrades the pg-boss schema as the migration role, creates the queues and lets the app
 * role use them. Safe to run on every deploy.
 */
export async function installJobSchema(adminUrl: string, appRole = 'cleanpost_app'): Promise<void> {
  const boss = new PgBoss({
    connectionString: adminUrl,
    schema: JOB_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    max: 1,
  });
  await boss.start();
  try {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    for (const q of QUEUES) {
      if (existing.has(q.name)) await boss.updateQueue(q.name, omitFixed(q.options));
      else await boss.createQueue(q.name, q.options);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(appRole);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${JOB_SCHEMA} TO ${role}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO ${role}`,
    );
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${JOB_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
  } finally {
    await client.end();
  }
}

function omitFixed(options: Parameters<PgBoss['createQueue']>[1]) {
  const { policy: _policy, deadLetter: _deadLetter, ...rest } = options ?? {};
  return rest;
}

export async function sendClaimBuild(boss: PgBoss, payload: ClaimBuildPayload): Promise<string | null> {
  const data = claimBuildPayload.parse(payload);
  return boss.send(JOBS.claimBuild, data, { singletonKey: data.clientId });
}

export async function sendClaimScrub(boss: PgBoss, payload: ClaimScrubPayload): Promise<string | null> {
  const data = claimScrubPayload.parse(payload);
  return boss.send(JOBS.claimScrub, data, { singletonKey: data.claimVersionId });
}

/**
 * Queues a release. A person's approval waits `delaySeconds` (10 in W-10) so Undo can cancel it
 * before anything reaches the PM (docs/09-ui-screens.md).
 */
export async function sendClaimRelease(
  boss: PgBoss,
  payload: ClaimReleasePayload,
  opts: { delaySeconds?: number } = {},
): Promise<string | null> {
  const data = claimReleasePayload.parse(payload);
  return boss.send(JOBS.claimRelease, data, {
    singletonKey: data.claimId,
    ...(opts.delaySeconds ? { startAfter: opts.delaySeconds } : {}),
  });
}

export async function sendEligibilityCheck(
  boss: PgBoss,
  payload: EligibilityCheckPayload,
): Promise<string | null> {
  const data = eligibilityCheckPayload.parse(payload);
  return boss.send(JOBS.eligibilityCheck, data, { singletonKey: data.coverageId });
}

export async function sendClaimStatusCheck(
  boss: PgBoss,
  payload: ClaimStatusCheckPayload,
  opts: { delaySeconds?: number } = {},
): Promise<string | null> {
  const data = claimStatusCheckPayload.parse(payload);
  return boss.send(JOBS.claimStatusCheck, data, {
    singletonKey: data.claimId,
    ...(opts.delaySeconds ? { startAfter: opts.delaySeconds } : {}),
  });
}

export async function sendClaimCorrect(boss: PgBoss, payload: ClaimCorrectPayload): Promise<string | null> {
  const data = claimCorrectPayload.parse(payload);
  return boss.send(JOBS.claimCorrect, data, { singletonKey: data.claimId });
}

/** Undo: cancels a release that has not started. False if it already ran or is running. */
export async function cancelClaimRelease(boss: PgBoss, jobId: string): Promise<boolean> {
  const job = await boss.getJobById(JOBS.claimRelease, jobId);
  if (!job || job.state !== 'created') return false;
  await boss.cancel(JOBS.claimRelease, jobId);
  const after = await boss.getJobById(JOBS.claimRelease, jobId);
  return after?.state === 'cancelled';
}

/** Sending side, used by the web app (Run now) and the scheduler. */
export async function sendSyncPull(boss: PgBoss, payload: SyncPullPayload): Promise<string | null> {
  const data = syncPullPayload.parse(payload);
  return boss.send(JOBS.syncPull, data, { singletonKey: data.connectionId });
}

export { PgBoss };
