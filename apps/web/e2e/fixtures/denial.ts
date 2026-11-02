/**
 * e2e fixture for Flow 5 (docs/09): a denial to work, made the way it happens in Mode A with a PM
 * that has no hold. Cascade's PM bills a claim Cleanpost had blocked for a missing modifier 25
 * (billed outside Cleanpost), the payer accepts it, then denies the office visit CO-4 (N822) in an
 * 835, ingested as an upload. Runs through the app's own code paths, once per database: a denial
 * already made by this fixture is reused. Synthetic data only; prints IDs only.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { applyClaimEvent, markReleased } from '@cleanpost/claims';
import {
  claims,
  claimVersions,
  createDatabase,
  payers,
  remittances,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { CODE_GROUPS, type ClaimPayload, type remit } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { ingestRemittance } from '@cleanpost/remit';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const CASCADE = '01a00000-0000-7000-8000-0000000000c2';
const TRACE = 'E2E-DENIAL';

const inGroup = (g: string, code: string) => CODE_GROUPS[g]?.includes(code) ?? false;

async function main() {
  const admin = createDatabase(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const app = createDatabase(process.env.DATABASE_URL!, { max: 2 });
  const log = createLogger({ name: 'e2e-fixture' });
  try {
    const [made] = await admin.db
      .select({ id: workItems.id })
      .from(workItems)
      .innerJoin(remittances, eq(remittances.id, workItems.remittanceId))
      .where(and(eq(workItems.type, 'denial'), like(remittances.traceNumber, `${TRACE}%`)));
    if (made) return;

    // A blocked claim with an office visit and a procedure or preventive visit, without 25.
    const blocked = await admin.db
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
    const lines = (pick.payload as ClaimPayload).lines;
    const pcn = `E2E${c.id.slice(-8).toUpperCase()}`;

    await withTenant(app.db, { tenantId: NORTHWIND }, async (tx) => {
      // The PM billed it at its batch while Cleanpost had it blocked; the payer accepted it.
      await markReleased(tx, c, 'pm_outside_cleanpost', 'automation:e2e-fixture', new Date());
      await tx.update(claims).set({ patientControlNumber: pcn }).where(eq(claims.id, c.id));
      await applyClaimEvent(tx, { ...c, status: 'submitted' }, 'accept', { actor: 'automation:e2e-fixture' });
    });

    const [payer] = c.payerId ? await admin.db.select().from(payers).where(eq(payers.id, c.payerId)) : [];
    const paidLines: remit.ServiceLinePayment[] = lines.map((l) => {
      const denied = inGroup('em_office', l.code) && !l.modifiers.includes('25');
      const allowed = Math.round(l.chargeCents * 0.7);
      return {
        code: l.code,
        modifiers: l.modifiers,
        chargeCents: l.chargeCents,
        paidCents: denied ? 0 : allowed,
        units: l.units,
        allowedCents: denied ? 0 : allowed,
        lineControlNumber: null,
        serviceDate: null,
        adjustments: denied
          ? [{ group: 'CO', carc: '4', amountCents: l.chargeCents }]
          : l.chargeCents > allowed
            ? [{ group: 'CO', carc: '45', amountCents: l.chargeCents - allowed }]
            : [],
        remarks: denied ? ['N822'] : [],
      };
    });
    const paid = paidLines.reduce((s, l) => s + l.paidCents, 0);
    const res = await ingestRemittance(
      { db: app.db, log },
      { tenantId: NORTHWIND, clientId: CASCADE, source: 'file', actor: 'automation:e2e-fixture' },
      {
        payment: {
          method: paid ? 'ACH' : 'NON',
          amountCents: paid,
          paymentDate: '2026-11-02',
          traceNumber: `${TRACE}-${pcn}`,
        },
        payer: { name: payer?.name ?? 'AETNA', id: payer?.stediPayerId ?? null },
        payee: { name: 'CASCADE PEDIATRICS', npi: null },
        providerAdjustments: [],
        claims: [
          {
            patientControlNumber: pcn,
            statusCode: '1',
            chargeCents: paidLines.reduce((s, l) => s + l.chargeCents, 0),
            paidCents: paid,
            patientRespCents: 0,
            payerClaimControlNumber: `PCN-${pcn}`,
            frequencyCode: '1',
            patient: null,
            serviceDateFrom: null,
            adjustments: [],
            remarks: [],
            crossoverPayerName: null,
            lines: paidLines,
          },
        ],
      },
    );
    process.stdout.write(
      `${JSON.stringify({ claimId: c.id, remittanceId: res.remittanceId, status: res.status })}\n`,
    );
  } finally {
    await Promise.all([admin.close(), app.close()]);
  }
}

await main();
