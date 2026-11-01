import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { runMigrations } from './migrate';

const log = createLogger({ name: 'db-migrate' });
const { DATABASE_ADMIN_URL } = parseEnv(z.object({ DATABASE_ADMIN_URL: z.string().min(1) }));

runMigrations(DATABASE_ADMIN_URL)
  .then(() => log.info('migrations applied'))
  .catch((err: unknown) => {
    log.error({ err }, 'migration failed');
    process.exitCode = 1;
  });
