import pg from 'pg';
import { prepareTestDatabase, testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { migratePmDb } from '@cleanpost/pm-mock';

/** Cleanpost's schema from migrations, plus pm-mock's own schema in the same test database. */
export default async function setup() {
  await prepareTestDatabase('sync');
  const { adminUrl } = testDatabaseUrls(testDatabaseName('sync'));
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS pm_mock CASCADE');
  } finally {
    await client.end();
  }
  await migratePmDb(adminUrl);
}
