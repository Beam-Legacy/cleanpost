import pg from 'pg';
import { prepareTestDatabase, testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { migrateSimDb } from '@cleanpost/payer-sim';

/** Cleanpost's schema from migrations, plus payer-sim's own schema in the same test database. */
export default async function setup() {
  await prepareTestDatabase('eligibility');
  const { adminUrl } = testDatabaseUrls(testDatabaseName('eligibility'));
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS payer_sim CASCADE');
  } finally {
    await client.end();
  }
  await migrateSimDb(adminUrl);
}
