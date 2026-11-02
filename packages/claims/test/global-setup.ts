import pg from 'pg';
import { prepareTestDatabase, testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { migratePmDb } from '@cleanpost/pm-mock';
import { migrateSimDb } from '@cleanpost/payer-sim';

/** Cleanpost's schema from migrations, plus pm-mock's and payer-sim's own schemas in the same test database. */
export default async function setup() {
  await prepareTestDatabase('claims');
  const { adminUrl } = testDatabaseUrls(testDatabaseName('claims'));
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS pm_mock CASCADE');
    await client.query('DROP SCHEMA IF EXISTS payer_sim CASCADE');
  } finally {
    await client.end();
  }
  await migratePmDb(adminUrl);
  await migrateSimDb(adminUrl);
}
