/**
 * e2e fixture for C-15 and W-15 (docs/09): a claim with an open follow-up and a status answer, made
 * through the app's own code. A Lakeside claim the PM billed and the payer accepted gets a "no
 * payment" follow-up from the daily sweep (run as of 31 days later), and a status check whose payer
 * answer (a canned 277 in Stedi's normalized shape: P3/21, pended for records) is stored like any
 * other. CI runs no payer-sim, so the answer is canned here. Once per database; synthetic data
 * only; prints IDs only.
 */
import { and, eq, inArray, like, ne } from 'drizzle-orm';
import { applyClaimEvent, checkClaimStatus, markReleased, statusSweep } from '@cleanpost/claims';
import { claims, createDatabase, withTenant, workItems, type Database } from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { ClaimStatusClient } from '@cleanpost/eligibility';
import { createLogger } from '@cleanpost/log';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const LAKESIDE = '01a00000-0000-7000-8000-0000000000c1';
const ACTOR = 'automation:e2e-fixture' as const;
const DAY = 86_400_000;

async function main() {
  const admin = createDatabase(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const app = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  const log = createLogger({ name: 'e2e-fixture' });
  try {
    const [done] = await admin.db
      .select({ id: claims.id })
      .from(claims)
      .where(like(claims.patientControlNumber, 'E2S%'));
    if (done) return;
    const [c] = await admin.db
      .select()
      .from(claims)
      .where(and(eq(claims.clientId, LAKESIDE), inArray(claims.status, ['needs_review', 'blocked'])))
      .limit(1);
    if (!c) throw new Error('no Lakeside claim in review');
    const pcn = `E2S${c.id.slice(-8).toUpperCase()}`;
    await billedAndAccepted(app.db, c, pcn);

    // A month on, the daily sweep opens the follow-up.
    await statusSweep(app.db, { tenantId: NORTHWIND }, new Date(Date.now() + 31 * DAY));
    const client: ClaimStatusClient = {
      kind: 'payer-sim',
      check: async () => ({
        ok: true,
        claims: [
          {
            category: 'P3',
            code: '21',
            entityCode: '41',
            effectiveDate: new Date().toISOString().slice(0, 10),
            payerClaimNumber: `SIM${c.id.slice(-6).toUpperCase()}`,
            patientAccountNumber: pcn,
            submittedCents: Number(c.totalChargeCents),
            paidCents: 0,
            paidDate: null,
            checkNumber: null,
            checkIssueDate: null,
          },
        ],
      }),
    };
    const res = await checkClaimStatus(
      { db: app.db, client, log },
      { tenantId: NORTHWIND, claimId: c.id, trigger: 'sweep' },
    );
    process.stdout.write(`${JSON.stringify({ claimId: c.id, status: res.status })}\n`);
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

/** The PM billed it while it was in review; the payer accepted it. Its review item closes. */
async function billedAndAccepted(app: Database, c: typeof claims.$inferSelect, pcn: string) {
  await withTenant(app, { tenantId: NORTHWIND }, async (tx) => {
    await markReleased(tx, c, 'pm_outside_cleanpost', ACTOR, new Date());
    await tx.update(claims).set({ patientControlNumber: pcn }).where(eq(claims.id, c.id));
    await applyClaimEvent(tx, { ...c, status: 'submitted' }, 'accept', { actor: ACTOR });
    const open = await tx
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, c.id),
          inArray(workItems.type, ['claim_review', 'claim_blocked']),
          ne(workItems.status, 'resolved'),
        ),
      );
    for (const item of open) {
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
      if (next.ok)
        await tx
          .update(workItems)
          .set({
            status: next.value,
            resolvedBy: ACTOR,
            resolvedAt: new Date(),
            resolution: 'Released in the PM',
          })
          .where(eq(workItems.id, item.id));
    }
  });
}

await main();
