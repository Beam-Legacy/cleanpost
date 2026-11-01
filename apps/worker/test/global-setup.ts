import pg from 'pg';
import { prepareTestDatabase, testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { installJobSchema } from '@cleanpost/jobs';
import { migratePmDb } from '@cleanpost/pm-mock';

/** Cleanpost from migrations, the job queue schema, and pm-mock's schema, all fresh. */
export default async function setup() {
  await prepareTestDatabase('worker');
  const { adminUrl } = testDatabaseUrls(testDatabaseName('worker'));
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS pm_mock CASCADE');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  } finally {
    await client.end();
  }
  await migratePmDb(adminUrl);
  await installJobSchema(adminUrl);
}
