import pg from 'pg';
import { prepareTestDatabase, testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { installJobSchema } from '@cleanpost/jobs';
import { migratePmDb } from '@cleanpost/pm-mock';
import { migrateSimDb } from '@cleanpost/payer-sim';

/** Cleanpost from migrations, the job queue schema, and pm-mock's and payer-sim's schemas, all fresh. */
export default async function setup() {
  await prepareTestDatabase('cycle');
  const { adminUrl } = testDatabaseUrls(testDatabaseName('cycle'));
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS pm_mock CASCADE');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
    await client.query('DROP SCHEMA IF EXISTS payer_sim CASCADE');
  } finally {
    await client.end();
  }
  await migratePmDb(adminUrl);
  await migrateSimDb(adminUrl);
  await installJobSchema(adminUrl);
}
