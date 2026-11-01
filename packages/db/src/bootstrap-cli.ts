/**
 * Creates the database roles the apps need, on a fresh managed Postgres (preview, staging):
 * cleanpost_app (grants holder, never BYPASSRLS) and a login role for the apps that is a member of
 * it. Local and CI do the same in docker/postgres/init.sql. Safe to run on every deploy.
 */
import pg from 'pg';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';

const log = createLogger({ name: 'db-bootstrap' });
const env = parseEnv(
  z.object({
    DATABASE_ADMIN_URL: z.string().min(1),
    APP_DB_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default('cleanpost_web'),
    APP_DB_PASSWORD: z.string().min(24),
  }),
);

async function main() {
  const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    const user = client.escapeIdentifier(env.APP_DB_USER);
    const password = client.escapeLiteral(env.APP_DB_PASSWORD);
    const exists = async (name: string) =>
      ((await client.query('select 1 from pg_roles where rolname = $1', [name])).rowCount ?? 0) > 0;
    if (!(await exists('cleanpost_app'))) await client.query('create role cleanpost_app nologin nobypassrls');
    if (await exists(env.APP_DB_USER)) {
      await client.query(`alter role ${user} login nobypassrls nosuperuser password ${password}`);
    } else {
      await client.query(`create role ${user} login nobypassrls password ${password}`);
    }
    await client.query(`grant cleanpost_app to ${user}`);
    const db = (await client.query<{ db: string }>('select current_database() as db')).rows[0]!.db;
    await client.query(`grant connect on database ${client.escapeIdentifier(db)} to cleanpost_app`);
    log.info({ role: env.APP_DB_USER }, 'database roles ready');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  log.error({ err }, 'bootstrap failed');
  process.exitCode = 1;
});
