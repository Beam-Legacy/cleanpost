/** Installs the job queue schema as the migration role (part of `pnpm db:migrate`). */
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { installJobSchema } from './index';

const log = createLogger({ name: 'jobs-install' });
const env = parseEnv(z.object({ DATABASE_ADMIN_URL: z.string().min(1) }));

installJobSchema(env.DATABASE_ADMIN_URL)
  .then(() => log.info('job queue schema ready'))
  .catch((err: unknown) => {
    log.error({ err }, 'job queue install failed');
    process.exitCode = 1;
  });
