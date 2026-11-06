/**
 * Worker entry point: pg-boss jobs (sync.pull every minute's tick, dead letters) and a health
 * endpoint for the platform. Connects as the app role, so RLS applies to every job.
 */
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  createBedrockCardReader,
  createBedrockReviewModel,
  createClaimReviewer,
  createStandInCardReader,
  createStandInReviewModel,
  DEFAULT_MODELS,
} from '@cleanpost/ai';
import { emailEnvSchema, parseEnv } from '@cleanpost/config';
import { createDatabase, syncClock } from '@cleanpost/db';
import { createStediClaimStatusClient, createStediEligibilityClient } from '@cleanpost/eligibility';
import { createSmtpMailer } from '@cleanpost/email';
import { createBoss, demoWorkdayPayload, JOBS, sendUsageMeter, waitForQueues } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { createHistoryRunner } from './demo-history';
import { buildRegistry, handleStatusSweep, registerWorkers } from './handlers';

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
    /** Scrub step 2. stedi: Stedi 270/271; payer-sim: the simulator (local, preview); off: skip. */
    ELIGIBILITY: z.enum(['stedi', 'payer-sim', 'off']).optional(),
    STEDI_API_KEY: z.string().min(8).optional(),
    STEDI_BASE_URL: z.url().optional(),
    PAYER_SIM_URL: z.url().optional(),
    PAYER_SIM_TOKEN: z.string().min(24).optional(),
    /** Demo history (DEC-19): the mock PM's admin API, where the replay enters visits. */
    PM_MOCK_ADMIN_PASSWORD: z.string().min(12).optional(),
    /** Notification emails (E-04, E-05, E-06): links point at the web app; SMTP_HOST=log only logs. */
    APP_URL: z.url().optional(),
    SMTP_HOST: z.string().min(1).optional(),
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

// P-04 card reading follows the AI mode: Bedrock where synthetic data or a BAA covers it; the
// stand-in (local and preview) reads only the synthetic cards the simulators make (DEC-31).
const cardReader =
  aiMode === 'bedrock'
    ? createBedrockCardReader({
        model: env.AI_MODEL_ROUTINE,
        ...(env.AWS_REGION ? { awsRegion: env.AWS_REGION } : {}),
      })
    : aiMode === 'stand-in'
      ? createStandInCardReader()
      : undefined;

const eligibilityMode =
  env.ELIGIBILITY ?? (env.STEDI_API_KEY ? 'stedi' : synthetic && env.PAYER_SIM_URL ? 'payer-sim' : 'off');
if (eligibilityMode === 'payer-sim' && (!synthetic || !env.PAYER_SIM_URL)) {
  log.error('ELIGIBILITY=payer-sim needs PAYER_SIM_URL and is only allowed in local and preview');
  process.exit(1);
}
if (eligibilityMode === 'stedi' && !env.STEDI_API_KEY) {
  log.error('ELIGIBILITY=stedi needs STEDI_API_KEY');
  process.exit(1);
}
const eligibility =
  eligibilityMode === 'stedi'
    ? createStediEligibilityClient({
        apiKey: env.STEDI_API_KEY!,
        ...(env.STEDI_BASE_URL ? { baseUrl: env.STEDI_BASE_URL } : {}),
      })
    : eligibilityMode === 'payer-sim'
      ? createStediEligibilityClient({
          apiKey: env.PAYER_SIM_TOKEN ?? 'payer-sim',
          baseUrl: env.PAYER_SIM_URL!,
          kind: 'payer-sim',
        })
      : undefined;

// Claim status (276/277) follows the same switch: Stedi's test keys do not cover it, so preview
// uses payer-sim's copy of the endpoint.
const claimStatusClient =
  eligibilityMode === 'stedi'
    ? createStediClaimStatusClient({
        apiKey: env.STEDI_API_KEY!,
        ...(env.STEDI_BASE_URL ? { baseUrl: env.STEDI_BASE_URL } : {}),
      })
    : eligibilityMode === 'payer-sim'
      ? createStediClaimStatusClient({
          apiKey: env.PAYER_SIM_TOKEN ?? 'payer-sim',
          baseUrl: env.PAYER_SIM_URL!,
          kind: 'payer-sim',
        })
      : undefined;

// Without SMTP settings and the app's URL, notifications stay in-app (G-04) and no email goes.
const mailer = env.SMTP_HOST && env.APP_URL ? createSmtpMailer(parseEnv(emailEnvSchema)) : undefined;
if (!mailer) log.warn('notification emails are off: set SMTP_HOST, SMTP_PORT, EMAIL_FROM and APP_URL');

const handle = createDatabase(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 2 });
// Demo time (DEC-18): follow the shared clock offset (always 0 outside local and preview).
const clockOffsetMs = await syncClock(handle.db);
const clockTimer = setInterval(() => {
  syncClock(handle.db).catch((err: unknown) => log.warn({ err }, 'clock sync failed'));
}, 2000);
let stopping = false;
// Up before the job queue: a deploy waiting for its release step's new queues stays healthy.
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

const boss = createBoss(env.DATABASE_URL, 'worker');
boss.on('error', (err) => log.error({ err }, 'job queue error'));
await boss.start();
await waitForQueues(boss, {
  signal: () => stopping,
  onWait: (missing) => log.warn({ missing }, 'waiting for the release step to create job queues'),
});
const registry = buildRegistry({
  db: handle.db,
  ...(mockAllowed && env.PM_MOCK_URL && env.PM_MOCK_SECRET
    ? { pmMock: { url: env.PM_MOCK_URL, secret: env.PM_MOCK_SECRET } }
    : {}),
});
await registerWorkers(
  {
    db: handle.db,
    boss,
    log,
    registry,
    ...(mailer && env.APP_URL ? { mailer, appUrl: env.APP_URL } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(cardReader ? { cardReader } : {}),
    ...(eligibility ? { eligibility } : {}),
    ...(claimStatusClient ? { claimStatus: claimStatusClient } : {}),
  },
  { concurrency: env.WORKER_CONCURRENCY },
);
// Usage records are caught up at start too, not only at the nightly run (a backfill for a new company).
await sendUsageMeter(boss).catch((err: unknown) =>
  log.warn({ err: (err as Error).name }, 'usage meter not queued'),
);
// Demo history (DEC-19): replay the 90 days `pnpm demo:reset` set up, when one is pending.
const history =
  synthetic && env.PM_MOCK_URL && env.PM_MOCK_ADMIN_PASSWORD && env.PAYER_SIM_URL
    ? createHistoryRunner({
        db: handle.db,
        boss,
        log,
        pmMock: { url: env.PM_MOCK_URL.replace(/\/$/, ''), adminPassword: env.PM_MOCK_ADMIN_PASSWORD },
        payerSim: {
          url: env.PAYER_SIM_URL.replace(/\/$/, ''),
          ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
        },
        sweep: () =>
          handleStatusSweep({
            db: handle.db,
            boss,
            log,
            registry,
            ...(claimStatusClient ? { claimStatus: claimStatusClient } : {}),
          }),
      })
    : undefined;
let replaying = false;
const historyTimer = history
  ? setInterval(() => {
      if (replaying || stopping) return;
      replaying = true;
      history
        .run()
        .catch((err: unknown) => log.error({ err }, 'demo history check failed'))
        .finally(() => {
          replaying = false;
        });
    }, 15_000)
  : undefined;
// After the Demo clock moves: the simulated team works the day (DEC-19), unless a replay is on.
if (history)
  await boss.work(JOBS.demoWorkday, async ([job]) => {
    if (!job || replaying) return;
    replaying = true;
    try {
      await history.workDay(demoWorkdayPayload.parse(job.data).days);
    } finally {
      replaying = false;
    }
  });

log.info(
  {
    mockPm: Boolean(env.PM_MOCK_URL),
    demoHistory: Boolean(history),
    aiReview: aiMode,
    eligibility: eligibilityMode,
    concurrency: env.WORKER_CONCURRENCY,
    demoClockDays: Math.round(clockOffsetMs / 86_400_000),
  },
  'worker started',
);

async function stop() {
  if (stopping) return;
  stopping = true;
  log.info('worker stopping');
  clearInterval(clockTimer);
  if (historyTimer) clearInterval(historyTimer);
  server.close();
  await boss.stop({ graceful: true, timeout: 30_000 });
  await handle.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
