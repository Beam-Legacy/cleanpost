import pg from 'pg';
import { runMigrations } from '../src/migrate';
import { TEST_DATABASE_ADMIN_URL } from './env';

/** Rebuilds the test database from migrations before the suite runs. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_ADMIN_URL });
  await client.connect();
  await client.query(`
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    DROP SCHEMA IF EXISTS app CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `);
  await client.end();
  await runMigrations(TEST_DATABASE_ADMIN_URL);
}
