/**
 * Worker entry point: pg-boss jobs (sync.pull every minute's tick, dead letters) and a health
 * endpoint for the platform. Connects as the app role, so RLS applies to every job.
 */
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  createBedrockReviewModel,
  createClaimReviewer,
  createStandInReviewModel,
  DEFAULT_MODELS,
} from '@cleanpost/ai';
import { parseEnv } from '@cleanpost/config';
import { createDatabase } from '@cleanpost/db';
import { createBoss } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { buildRegistry, registerWorkers } from './handlers';

const log = createLogger({ name: 'worker' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    DATABASE_URL: z.string().min(1),
    PM_MOCK_URL: z.url().optional(),
    PM_MOCK_SECRET: z.string().min(24).optional(),
    PORT: z.coerce.number().int().default(4020),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /** Scrub step 8. bedrock: Claude on AWS Bedrock; stand-in: fixed heuristics; off: skip. */
    AI_REVIEW: z.enum(['bedrock', 'stand-in', 'off']).optional(),
    AI_MODEL_ROUTINE: z.string().min(1).default(DEFAULT_MODELS.routine),
    AWS_REGION: z.string().optional(),
  }),
);

// The mock PM and the stand-in reviewer exist only where data is synthetic.
const synthetic = env.CLEANPOST_ENV === 'local' || env.CLEANPOST_ENV === 'preview';
const mockAllowed = synthetic;
if (!mockAllowed && (env.PM_MOCK_URL || env.PM_MOCK_SECRET)) {
  log.error('PM_MOCK_URL and PM_MOCK_SECRET are only allowed in local and preview');
  process.exit(1);
}
const aiMode = env.AI_REVIEW ?? (synthetic ? 'stand-in' : 'off');
if (aiMode === 'stand-in' && !synthetic) {
  log.error('AI_REVIEW=stand-in is only allowed in local and preview');
  process.exit(1);
}
const reviewer =
  aiMode === 'bedrock'
    ? createClaimReviewer({
        model: createBedrockReviewModel({
          model: env.AI_MODEL_ROUTINE,
          ...(env.AWS_REGION ? { awsRegion: env.AWS_REGION } : {}),
        }),
        log,
      })
    : aiMode === 'stand-in'
      ? createClaimReviewer({ model: createStandInReviewModel(), log })
      : undefined;

const handle = createDatabase(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 2 });
const boss = createBoss(env.DATABASE_URL, 'worker');
boss.on('error', (err) => log.error({ err }, 'job queue error'));
await boss.start();
const registry = buildRegistry({
  db: handle.db,
  ...(mockAllowed && env.PM_MOCK_URL && env.PM_MOCK_SECRET
    ? { pmMock: { url: env.PM_MOCK_URL, secret: env.PM_MOCK_SECRET } }
    : {}),
});
await registerWorkers(
  { db: handle.db, boss, log, registry, ...(reviewer ? { reviewer } : {}) },
  { concurrency: env.WORKER_CONCURRENCY },
);
log.info(
  { mockPm: Boolean(env.PM_MOCK_URL), aiReview: aiMode, concurrency: env.WORKER_CONCURRENCY },
  'worker started',
);

let stopping = false;
const server = createServer((req, res) => {
  const ok = req.url === '/health' && !stopping;
  res.writeHead(ok ? 200 : req.url === '/health' ? 503 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok }));
});
// IPv6 for Railway's private network where the host has it, else IPv4.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EAFNOSUPPORT') server.listen(env.PORT, '0.0.0.0');
  else log.error({ err }, 'health server error');
});
server.listen(env.PORT, '::');

async function stop() {
  if (stopping) return;
  stopping = true;
  log.info('worker stopping');
  server.close();
  await boss.stop({ graceful: true, timeout: 30_000 });
  await handle.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
