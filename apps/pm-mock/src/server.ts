/** pm-mock entry point. Applies its own migrations, then serves the API and admin page. */
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { createPmMockApp } from './app';
import { createPmDb, migratePmDb } from './db';

const log = createLogger({ name: 'pm-mock' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    PM_MOCK_DATABASE_URL: z.string().min(1),
    PM_MOCK_ADMIN_PASSWORD: z.string().min(12).optional(),
    PORT: z.coerce.number().int().default(4010),
  }),
);
if (env.CLEANPOST_ENV === 'staging' || env.CLEANPOST_ENV === 'production') {
  log.error('pm-mock only runs in local and preview');
  process.exit(1);
}

await migratePmDb(env.PM_MOCK_DATABASE_URL);
const handle = createPmDb(env.PM_MOCK_DATABASE_URL);
const app = createPmMockApp({ db: handle.db, log, adminPassword: env.PM_MOCK_ADMIN_PASSWORD });
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '::' }, (info) =>
  log.info({ port: info.port, admin: Boolean(env.PM_MOCK_ADMIN_PASSWORD) }, 'pm-mock listening'),
);

const stop = () => {
  server.close();
  void handle.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
