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

export async function sendClaimRelease(boss: PgBoss, payload: ClaimReleasePayload): Promise<string | null> {
  const data = claimReleasePayload.parse(payload);
  return boss.send(JOBS.claimRelease, data, { singletonKey: data.claimId });
}

/** Sending side, used by the web app (Run now) and the scheduler. */
export async function sendSyncPull(boss: PgBoss, payload: SyncPullPayload): Promise<string | null> {
  const data = syncPullPayload.parse(payload);
  return boss.send(JOBS.syncPull, data, { singletonKey: data.connectionId });
}

export { PgBoss };
