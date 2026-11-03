import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createSystemDatabase, enableDemoTime } from '@cleanpost/db/system';
import { createLogger } from '@cleanpost/log';
import { seed, SEED_USERS } from './seed';

const log = createLogger({ name: 'seed' });
const env = parseEnv(
  z.object({
    /** Deployment environment: local | preview | staging | production. Synthetic seeding is refused in production. */
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    DATABASE_ADMIN_URL: z.string().min(1),
    SEED_PASSWORD: z.string().min(12).default('cleanpost-dev-password'),
  }),
);
if (env.CLEANPOST_ENV === 'production') {
  log.error('refusing to seed synthetic data in production');
  process.exit(1);
}

const handle = createSystemDatabase(env.DATABASE_ADMIN_URL);
seed(handle.db, env.SEED_PASSWORD)
  .then(async ({ created }) => {
    // Demo time (DEC-18): the demo clock may move here; staging keeps the real clock.
    if (env.CLEANPOST_ENV === 'local' || env.CLEANPOST_ENV === 'preview') await enableDemoTime(handle.db);
    log.info({ createdUsers: created.length }, 'seed complete');
    process.stdout.write(
      `Seeded synthetic data. Sign in as any of: ${SEED_USERS.map((u) => u.email).join(', ')}\n` +
        'Password: the SEED_PASSWORD value (default in packages/seed/src/cli.ts). Each user sets up two-factor on first sign-in.\n',
    );
  })
  .catch((err: unknown) => {
    log.error({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => handle.close());
