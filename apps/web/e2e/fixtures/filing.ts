/**
 * e2e fixture for W-22: a claim in review whose filing limit is two days away, found by the
 * notification sweep's timely-filing watch (packages/notify), the app's own code. Runs once per
 * database (an open item it made is reused). Synthetic data only; prints IDs only.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { now } from '@cleanpost/clock';
import { claims, createDatabase, workItems } from '@cleanpost/db';
import { createLogger } from '@cleanpost/log';
import { sweepTenant } from '@cleanpost/notify';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
// Lakeside, Cascade, Willamette: the clients the mock PM syncs.
const CLIENTS = [
  '01a00000-0000-7000-8000-0000000000c1',
  '01a00000-0000-7000-8000-0000000000c2',
  '01a00000-0000-7000-8000-0000000000c3',
];
const log = createLogger({ name: 'e2e-fixture' });

async function main() {
  const adminDb = createDatabase(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const appDb = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  try {
    const [made] = await adminDb.db
      .select({ id: workItems.id })
      .from(workItems)
      .innerJoin(claims, eq(claims.id, workItems.claimId))
      .where(
        and(
          eq(workItems.type, 'timely_filing_risk'),
          ne(workItems.status, 'resolved'),
          inArray(claims.status, ['needs_review', 'ready', 'blocked']),
          inArray(claims.clientId, CLIENTS),
        ),
      );
    if (made) {
      process.stdout.write(`${JSON.stringify({ itemId: made.id, reused: true })}\n`);
      return;
    }
    // The last claim in review (the eligibility fixture takes the first), or else one blocked.
    const [c] = await adminDb.db
      .select({ id: claims.id })
      .from(claims)
      .innerJoin(workItems, eq(workItems.claimId, claims.id))
      .where(
        and(
          inArray(claims.clientId, CLIENTS),
          inArray(claims.status, ['needs_review', 'blocked']),
          inArray(workItems.type, ['claim_review', 'claim_blocked']),
          ne(workItems.status, 'resolved'),
          // Never had a W-22 item: one a person resolved is not reopened (DEC-32).
          sql`not exists (select 1 from work_items t where t.claim_id = ${claims.id} and t.type = 'timely_filing_risk')`,
        ),
      )
      .orderBy(desc(workItems.type), desc(claims.id))
      .limit(1);
    if (!c) throw new Error('no claim in review to put near its filing limit');
    await adminDb.db
      .update(claims)
      .set({ filingDeadline: sql`((app.now() at time zone 'America/Los_Angeles')::date + 2)` })
      .where(eq(claims.id, c.id));
    await sweepTenant({ db: appDb.db, log }, NORTHWIND, now());
    const [item] = await adminDb.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, c.id),
          eq(workItems.type, 'timely_filing_risk'),
          ne(workItems.status, 'resolved'),
        ),
      );
    process.stdout.write(`${JSON.stringify({ itemId: item?.id ?? null, claimId: c.id })}\n`);
  } finally {
    await Promise.all([adminDb.close(), appDb.close()]);
  }
}

await main();
