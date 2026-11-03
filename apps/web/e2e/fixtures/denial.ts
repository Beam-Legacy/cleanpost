/**
 * e2e fixtures for Flow 5 and D-01 to D-03 (docs/09): denials to work, made the way they happen in
 * Mode A, through the app's own code paths. Each runs once per database (a denial already made by
 * it is reused). Synthetic data only; prints IDs only.
 *
 * - E2E-DENIAL: Cascade's PM bills a claim Cleanpost had blocked for a missing modifier 25 (billed
 *   outside Cleanpost), the payer accepts it, then denies the office visit CO-4 (N822).
 * - E2E-AUTH: Willamette's largest unreleased claim, over the $500 approval limit, billed by the PM
 *   and denied in full CO-197 (N54): an authorization denial a biller must ask to write off.
 */
import { and, desc, eq, gt, inArray, like, ne } from 'drizzle-orm';
import { applyClaimEvent, markReleased } from '@cleanpost/claims';
import {
  claims,
  claimVersions,
  createDatabase,
  payers,
  remittances,
  withTenant,
  workItems,
  type Database,
} from '@cleanpost/db';
import { CODE_GROUPS, state, type ClaimPayload, type remit } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { ingestRemittance } from '@cleanpost/remit';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const CASCADE = '01a00000-0000-7000-8000-0000000000c2';
const WILLAMETTE = '01a00000-0000-7000-8000-0000000000c3';

const inGroup = (g: string, code: string) => CODE_GROUPS[g]?.includes(code) ?? false;

type ClaimRow = typeof claims.$inferSelect;
const log = createLogger({ name: 'e2e-fixture' });
const ACTOR = 'automation:e2e-fixture' as const;

/** An open denial this fixture already made (by its trace prefix); a resolved one is made again. */
async function made(admin: Database, trace: string) {
  const [m] = await admin
    .select({ id: workItems.id })
    .from(workItems)
    .innerJoin(remittances, eq(remittances.id, workItems.remittanceId))
    .where(
      and(
        eq(workItems.type, 'denial'),
        ne(workItems.status, 'resolved'),
        like(remittances.traceNumber, `${trace}%`),
      ),
    );
  return Boolean(m);
}

/**
 * The PM billed it at its batch while Cleanpost had it in review or blocked; the payer accepted it.
 * Its review item closes, as the status sync closes it.
 */
async function billedOutside(app: Database, c: ClaimRow, pcn: string) {
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

/** The payer's 835 for the claim, ingested as an upload. */
async function deny(
  app: Database,
  admin: Database,
  c: ClaimRow,
  pcn: string,
  trace: string,
  lines: remit.ServiceLinePayment[],
) {
  const [payer] = c.payerId ? await admin.select().from(payers).where(eq(payers.id, c.payerId)) : [];
  const paid = lines.reduce((s, l) => s + l.paidCents, 0);
  return ingestRemittance(
    { db: app, log },
    { tenantId: NORTHWIND, clientId: c.clientId, source: 'file', actor: ACTOR },
    {
      payment: {
        method: paid ? 'ACH' : 'NON',
        amountCents: paid,
        paymentDate: '2026-11-02',
        traceNumber: `${trace}-${pcn}`,
      },
      payer: { name: payer?.name ?? 'AETNA', id: payer?.stediPayerId ?? null },
      payee: { name: 'E2E PRACTICE', npi: null },
      providerAdjustments: [],
      claims: [
        {
          patientControlNumber: pcn,
          statusCode: paid ? '1' : '4',
          chargeCents: lines.reduce((s, l) => s + l.chargeCents, 0),
          paidCents: paid,
          patientRespCents: 0,
          payerClaimControlNumber: `PCN-${pcn}`,
          frequencyCode: '1',
          patient: null,
          serviceDateFrom: null,
          adjustments: [],
          remarks: [],
          crossoverPayerName: null,
          lines,
        },
      ],
    },
  );
}

const line = (l: ClaimPayload['lines'][number], o: Partial<remit.ServiceLinePayment>) => ({
  code: l.code,
  modifiers: l.modifiers,
  chargeCents: l.chargeCents,
  units: l.units,
  lineControlNumber: null,
  serviceDate: null,
  paidCents: 0,
  allowedCents: 0,
  adjustments: [],
  remarks: [],
  ...o,
});

/** E2E-DENIAL: a CO-4 on the office visit of a Cascade claim (Flow 5). */
async function co4Denial(app: Database, admin: Database) {
  const trace = 'E2E-DENIAL';
  if (await made(admin, trace)) return null;
  const blocked = await admin
    .select({ claim: claims, payload: claimVersions.payload })
    .from(claims)
    .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
    .where(and(eq(claims.clientId, CASCADE), inArray(claims.status, ['blocked'])));
  const pick = blocked.find(({ payload }) => {
    const lines = (payload as ClaimPayload).lines;
    const visit = lines.find((l) => inGroup('em_office', l.code) && !l.modifiers.includes('25'));
    return (
      visit &&
      lines.some(
        (l) => l !== visit && (inGroup('em_preventive', l.code) || inGroup('minor_procedures', l.code)),
      )
    );
  });
  if (!pick) throw new Error('no blocked Cascade claim with an office visit missing modifier 25');
  const c = pick.claim;
  const pcn = `E2E${c.id.slice(-8).toUpperCase()}`;
  await billedOutside(app, c, pcn);
  const lines = (pick.payload as ClaimPayload).lines.map((l) => {
    const denied = inGroup('em_office', l.code) && !l.modifiers.includes('25');
    const allowed = Math.round(l.chargeCents * 0.7);
    return line(l, {
      paidCents: denied ? 0 : allowed,
      allowedCents: denied ? 0 : allowed,
      adjustments: denied
        ? [{ group: 'CO', carc: '4', amountCents: l.chargeCents }]
        : l.chargeCents > allowed
          ? [{ group: 'CO', carc: '45', amountCents: l.chargeCents - allowed }]
          : [],
      remarks: denied ? ['N822'] : [],
    });
  });
  const res = await deny(app, admin, c, pcn, trace, lines);
  return { claimId: c.id, remittanceId: res.remittanceId, status: res.status };
}

/** E2E-AUTH: a whole Willamette claim over the approval limit denied CO-197 (D-02, D-03). */
async function authDenial(app: Database, admin: Database) {
  const trace = 'E2E-AUTH';
  if (await made(admin, trace)) return null;
  const [pick] = await admin
    .select({ claim: claims, payload: claimVersions.payload })
    .from(claims)
    .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
    .where(
      and(
        eq(claims.clientId, WILLAMETTE),
        inArray(claims.status, ['blocked', 'needs_review', 'ready', 'built']),
        gt(claims.totalChargeCents, 60_000),
      ),
    )
    .orderBy(desc(claims.totalChargeCents))
    .limit(1);
  if (!pick) throw new Error('no unreleased Willamette claim over $600');
  const c = pick.claim;
  const pcn = `E2A${c.id.slice(-8).toUpperCase()}`;
  await billedOutside(app, c, pcn);
  const lines = (pick.payload as ClaimPayload).lines.map((l) =>
    line(l, { adjustments: [{ group: 'CO', carc: '197', amountCents: l.chargeCents }], remarks: ['N54'] }),
  );
  const res = await deny(app, admin, c, pcn, trace, lines);
  return { claimId: c.id, remittanceId: res.remittanceId, status: res.status };
}

async function main() {
  const admin = createDatabase(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const app = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  try {
    const made = { co4: await co4Denial(app.db, admin.db), auth: await authDenial(app.db, admin.db) };
    process.stdout.write(`${JSON.stringify(made)}\n`);
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

await main();
