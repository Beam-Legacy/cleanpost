/** pm-mock entry point. Applies its own migrations, then serves the API and admin page. */
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { createPmMockApp } from './app';
import { runClearinghouse, type ClearinghouseRun } from './clearinghouse';
import { createPmDb, migratePmDb } from './db';
import { loadRoster } from './roster';
import { resetPmMockForHistory } from './seed';

const log = createLogger({ name: 'pm-mock' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    PM_MOCK_DATABASE_URL: z.string().min(1),
    PM_MOCK_ADMIN_PASSWORD: z.string().min(12).optional(),
    PORT: z.coerce.number().int().default(4010),
    /** payer-sim for the clearinghouse (docs/12-testing.md); claims stay queued without it. */
    PAYER_SIM_URL: z.url().optional(),
    PAYER_SIM_TOKEN: z.string().min(24).optional(),
    CLEARINGHOUSE_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(60),
  }),
);
if (env.CLEANPOST_ENV === 'staging' || env.CLEANPOST_ENV === 'production') {
  log.error('pm-mock only runs in local and preview');
  process.exit(1);
}

await migratePmDb(env.PM_MOCK_DATABASE_URL);
const handle = createPmDb(env.PM_MOCK_DATABASE_URL);

// Demo time (DEC-18): the PM keeps the payer simulator's date, so the billing batch, ERA postings
// and record timestamps match the demo clock. Read every few seconds and before each clearinghouse run.
let clockOffsetMs = 0;
const now = () => new Date(Date.now() + clockOffsetMs);
const clockBody = z.object({ now: z.iso.datetime({ offset: true }) });
async function followSimClock(): Promise<void> {
  if (!env.PAYER_SIM_URL) return;
  try {
    const res = await fetch(`${env.PAYER_SIM_URL.replace(/\/$/, '')}/clock`, {
      headers: env.PAYER_SIM_TOKEN ? { authorization: `Bearer ${env.PAYER_SIM_TOKEN}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    const body = res.ok ? clockBody.safeParse(await res.json()) : null;
    if (body?.success) clockOffsetMs = Date.parse(body.data.now) - Date.now();
  } catch {
    // payer-sim not answering: keep the last offset.
  }
}
await followSimClock();
const clockTimer = env.PAYER_SIM_URL ? setInterval(() => void followSimClock(), 5000) : undefined;
// The clearinghouse sends queued claims to payer-sim and reads 277CAs and 835s back, one run at a
// time. PMs with no hold also bill their ready encounters once a day at 6 pm Pacific (billReady).
let running: Promise<ClearinghouseRun> | null = null;
let billedOn: string | null = null;
const pacific = (d: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
const clearinghouse = env.PAYER_SIM_URL
  ? (opts: { bill?: boolean } = {}) =>
      (running ??= (async () => {
        await followSimClock();
        const p = pacific(now());
        const today = `${p.year}-${p.month}-${p.day}`;
        const batchDue = Number(p.hour) >= 18 && billedOn !== today;
        if (batchDue) billedOn = today;
        return runClearinghouse(
          {
            db: handle.db,
            log,
            now,
            payerSimUrl: env.PAYER_SIM_URL!,
            ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
          },
          { bill: Boolean(opts.bill) || batchDue },
        );
      })().finally(() => {
        running = null;
      }))
  : undefined;
// Demo history (DEC-19): payer-sim has already moved back; follow it, reload patients as of that
// date with no visits, and send the payers their member files again.
const demoReset = env.PAYER_SIM_URL
  ? async () => {
      await running;
      await followSimClock();
      const practices = await resetPmMockForHistory(handle.db, { asOf: now() });
      billedOn = null;
      const members = await loadRoster(handle.db, {
        payerSimUrl: env.PAYER_SIM_URL!.replace(/\/$/, ''),
        ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
      });
      log.info({ practices: practices.length, members }, 'pm-mock reset for demo history');
      return practices;
    }
  : undefined;
const app = createPmMockApp({
  db: handle.db,
  log,
  adminPassword: env.PM_MOCK_ADMIN_PASSWORD,
  now,
  ...(clearinghouse ? { clearinghouse } : {}),
  ...(demoReset ? { demoReset } : {}),
  refreshClock: followSimClock,
});
const timer = clearinghouse
  ? setInterval(() => {
      clearinghouse().catch((err: unknown) => log.warn({ err }, 'clearinghouse run failed'));
    }, env.CLEARINGHOUSE_INTERVAL_SECONDS * 1000)
  : undefined;
// Listen on IPv6 (Railway's private network needs it) where the host has it, else IPv4.
function listen(hostname: string): ReturnType<typeof serve> {
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname }, (info) =>
    log.info({ port: info.port, admin: Boolean(env.PM_MOCK_ADMIN_PASSWORD) }, 'pm-mock listening'),
  );
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EAFNOSUPPORT' && hostname === '::') current = listen('0.0.0.0');
    else throw err;
  });
  return server;
}
let current = listen('::');

const stop = () => {
  if (timer) clearInterval(timer);
  if (clockTimer) clearInterval(clockTimer);
  current.close();
  void handle.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
