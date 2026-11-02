import pg from 'pg';
import { testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { migrateSimDb } from '../src/db';

/** payer-sim's own test database: created if needed, its schema rebuilt from migrations. */
export default async function setup() {
  const name = testDatabaseName('payer_sim');
  const base = new pg.Client({ connectionString: testDatabaseUrls('cleanpost_test').adminUrl });
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
    await client.query('DROP SCHEMA IF EXISTS payer_sim CASCADE');
  } finally {
    await client.end();
  }
  await migrateSimDb(adminUrl);
}
