import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { createPmDb, migratePmDb } from './db';
import { loadRoster } from './roster';
import { seedPmMock } from './seed';

const log = createLogger({ name: 'pm-mock-seed' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    PM_MOCK_DATABASE_URL: z.string().min(1).optional(),
    PM_MOCK_SECRET: z.string().min(24).optional(),
    PAYER_SIM_URL: z.url().optional(),
    PAYER_SIM_TOKEN: z.string().min(24).optional(),
  }),
);
if (env.CLEANPOST_ENV === 'staging' || env.CLEANPOST_ENV === 'production') {
  log.error('pm-mock only runs in local and preview');
  process.exit(1);
}
if (!env.PM_MOCK_DATABASE_URL || !env.PM_MOCK_SECRET) {
  log.info('pm-mock seed skipped: PM_MOCK_DATABASE_URL and PM_MOCK_SECRET are not set');
  process.exit(0);
}

const url = env.PM_MOCK_DATABASE_URL;
const secret = env.PM_MOCK_SECRET;
await migratePmDb(url);
const handle = createPmDb(url);
try {
  const results = await seedPmMock(handle.db, { secret, asOf: new Date() });
  for (const r of results) log.info(r, r.loaded ? 'practice loaded' : 'practice already loaded');
  // The payers' member files, for eligibility checks against payer-sim.
  if (env.PAYER_SIM_URL) {
    try {
      const members = await loadRoster(handle.db, {
        payerSimUrl: env.PAYER_SIM_URL,
        ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
      });
      log.info({ members }, 'member files sent to payer-sim');
    } catch (err) {
      // payer-sim may not be up yet (a fresh preview); the next seed sends them.
      log.warn({ err }, 'payer-sim not reachable; member files not sent');
    }
  }
} catch (err) {
  log.error({ err }, 'pm-mock seed failed');
  process.exitCode = 1;
} finally {
  await handle.close();
}
