/**
 * e2e fixture for W-13, P-02 and P-06: an eligibility issue made the way it happens, through the
 * app's own code. A claim in review gets a 271 saying its coverage is inactive (as payer-sim
 * answers for an inactive member) and is scrubbed again: the claim is blocked and its item is an
 * eligibility issue. Runs once per database (an open issue it
 * made is reused). Synthetic data only; prints IDs only.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { rescrubForCoverage, scrubVersion } from '@cleanpost/claims';
import { claims, createDatabase, eligibilityChecks, users, workItems } from '@cleanpost/db';
import { createLogger } from '@cleanpost/log';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
// Lakeside, Cascade, Willamette: the clients the mock PM syncs.
const CLIENTS = [
  '01a00000-0000-7000-8000-0000000000c1',
  '01a00000-0000-7000-8000-0000000000c2',
  '01a00000-0000-7000-8000-0000000000c3',
];
const FIXTURE = 'e2e-eligibility';
const log = createLogger({ name: 'e2e-fixture' });

async function main() {
  const adminDb = createDatabase(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const appDb = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  const admin = adminDb.db;
  const app = appDb.db;
  try {
    const [made] = await admin
      .select({ id: workItems.id })
      .from(workItems)
      .innerJoin(claims, eq(claims.id, workItems.claimId))
      .innerJoin(eligibilityChecks, eq(eligibilityChecks.coverageId, claims.coverageId))
      .where(
        and(
          eq(workItems.type, 'eligibility_issue'),
          ne(workItems.status, 'resolved'),
          sql`${eligibilityChecks.summary}->>'fixture' = ${FIXTURE}`,
        ),
      );
    if (made) {
      process.stdout.write(`${JSON.stringify({ itemId: made.id, reused: true })}\n`);
      return;
    }
    const [priya] = await admin
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'priya@northwind.test'));
    // A claim in review (or already held by its coverage), in a synced client; the payer now says
    // its coverage is inactive.
    const candidates = await admin
      .select({ id: claims.id, coverageId: claims.coverageId, patientId: claims.patientId })
      .from(claims)
      .innerJoin(workItems, eq(workItems.claimId, claims.id))
      .where(
        and(
          inArray(claims.clientId, CLIENTS),
          inArray(workItems.type, ['claim_review', 'eligibility_issue']),
          ne(workItems.status, 'resolved'),
        ),
      )
      .orderBy(workItems.type, claims.id)
      .limit(1);
    for (const c of candidates) {
      if (!c.coverageId) continue;
      const [row] = await admin.select({ clientId: claims.clientId }).from(claims).where(eq(claims.id, c.id));
      await admin.insert(eligibilityChecks).values({
        tenantId: NORTHWIND,
        clientId: row!.clientId,
        coverageId: c.coverageId,
        status: 'inactive',
        summary: { fixture: FIXTURE, errorCodes: [] },
      });
      const versions = await rescrubForCoverage(app, {
        tenantId: NORTHWIND,
        userId: priya!.id,
        coverageId: c.coverageId,
      });
      for (const claimVersionId of versions)
        await scrubVersion({ db: app, log }, { tenantId: NORTHWIND, claimVersionId });
      const [item] = await admin
        .select({ id: workItems.id })
        .from(workItems)
        .where(
          and(
            eq(workItems.claimId, c.id),
            eq(workItems.type, 'eligibility_issue'),
            ne(workItems.status, 'resolved'),
          ),
        );
      process.stdout.write(`${JSON.stringify({ itemId: item?.id ?? null, claimId: c.id })}\n`);
      return;
    }
    throw new Error('no claim in review to give an eligibility issue');
  } finally {
    await Promise.all([adminDb.close(), appDb.close()]);
  }
}

await main();
