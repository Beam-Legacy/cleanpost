/** pm-mock entry point. Applies its own migrations, then serves the API and admin page. */
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { createPmMockApp } from './app';
import { runClearinghouse, type ClearinghouseRun } from './clearinghouse';
import { createPmDb, migratePmDb } from './db';

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
  ? (opts: { bill?: boolean } = {}) => {
      const p = pacific(new Date());
      const today = `${p.year}-${p.month}-${p.day}`;
      const batchDue = Number(p.hour) >= 18 && billedOn !== today;
      if (batchDue) billedOn = today;
      return (running ??= runClearinghouse(
        {
          db: handle.db,
          log,
          payerSimUrl: env.PAYER_SIM_URL!,
          ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
        },
        { bill: Boolean(opts.bill) || batchDue },
      ).finally(() => {
        running = null;
      }));
    }
  : undefined;
const app = createPmMockApp({
  db: handle.db,
  log,
  adminPassword: env.PM_MOCK_ADMIN_PASSWORD,
  ...(clearinghouse ? { clearinghouse } : {}),
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
  current.close();
  void handle.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
