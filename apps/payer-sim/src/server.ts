import { serve } from '@hono/node-server';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import { createPayerSimApp } from './app';
import { createSimDb, migrateSimDb } from './db';

const log = createLogger({ name: 'payer-sim' });
const env = parseEnv(
  z.object({
    CLEANPOST_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
    PAYER_SIM_DATABASE_URL: z.string().min(1),
    PAYER_SIM_TOKEN: z.string().min(24).optional(),
    PORT: z.coerce.number().int().default(4030),
  }),
);
if (env.CLEANPOST_ENV === 'staging' || env.CLEANPOST_ENV === 'production') {
  log.error('payer-sim only runs in local and preview');
  process.exit(1);
}

await migrateSimDb(env.PAYER_SIM_DATABASE_URL);
const handle = createSimDb(env.PAYER_SIM_DATABASE_URL);
const app = createPayerSimApp({
  db: handle.db,
  log,
  ...(env.PAYER_SIM_TOKEN ? { token: env.PAYER_SIM_TOKEN } : {}),
});
// Listen on IPv6 (Railway's private network needs it) where the host has it, else IPv4.
function listen(hostname: string) {
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname }, (info) =>
    log.info({ port: info.port }, 'payer-sim listening'),
  );
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EAFNOSUPPORT' && hostname === '::') listen('0.0.0.0');
    else throw err;
  });
}
listen('::');
