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
  current.close();
  void handle.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
