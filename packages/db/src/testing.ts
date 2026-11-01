/**
 * Test database helpers. Each package with database tests gets its own database
 * (cleanpost_test_<package>) so Turbo can run package suites in parallel.
 * The Vitest preset in @cleanpost/testing sets CLEANPOST_TEST_DB to the same name for workers.
 */
import pg from 'pg';
import { runMigrations } from './migrate';

const baseAdminUrl = () =>
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost_test';
const baseAppUrl = () =>
  process.env.TEST_DATABASE_URL ?? 'postgres://cleanpost_web:cleanpost_web@localhost:5432/cleanpost_test';

function onDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export const testDatabaseName = (pkg: string) => `cleanpost_test_${pkg.replace(/[^a-z0-9_]/gi, '_')}`;

/** URLs for the current package's test database: owner (adminUrl) and app role (url). */
export function testDatabaseUrls(name = process.env.CLEANPOST_TEST_DB ?? 'cleanpost_test') {
  return { adminUrl: onDatabase(baseAdminUrl(), name), url: onDatabase(baseAppUrl(), name) };
}

/** Vitest globalSetup: create the package's database if needed, empty it and run all migrations. */
export async function prepareTestDatabase(pkg: string): Promise<void> {
  const name = testDatabaseName(pkg);
  const base = new pg.Client({ connectionString: baseAdminUrl() });
  await base.connect();
  try {
    const exists = await base.query('select 1 from pg_database where datname = $1', [name]);
    if (!exists.rowCount) await base.query(`create database "${name}"`);
  } finally {
    await base.end();
  }
  const { adminUrl } = testDatabaseUrls(name);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
  } finally {
    await client.end();
  }
  await runMigrations(adminUrl);
}
