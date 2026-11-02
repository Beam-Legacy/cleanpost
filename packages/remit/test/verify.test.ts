/**
 * The posting match (docs/07): every matched 835 line ends verified, pending, or with exactly one
 * open work item, and the remittance moves verifying -> reconciled | posting_mismatch.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimLines,
  claims,
  claimVersions,
  createDatabase,
  encounters,
  patients,
  pmPostings,
  remitClaims,
  remitLines,
  remittances,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import type { remit } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import { ingestRemittance, storePmPostings, verifyInTx } from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const log = createLogger({ name: 'verify-test' });
const client = CLIENTS.find((c) => c.name.startsWith('Willamette'))!;
const CONN = '01a00000-0000-7000-8000-00000000c0c0';

async function sentClaim(pcn: string, lines: { code: string; chargeCents: number }[]) {
  const [p] = await admin.db
    .insert(patients)
    .values({
      tenantId: NORTHWIND,
      clientId: client.id,
      firstName: 'Avery',
      lastName: 'Tester',
      dob: '1980-02-14',
    })
    .returning();
  const [e] = await admin.db
    .insert(encounters)
    .values({
      tenantId: NORTHWIND,
      clientId: client.id,
      patientId: p!.id,
      dateOfService: '2026-10-27',
      status: 'claimed',
    })
    .returning();
  const total = lines.reduce((s, l) => s + l.chargeCents, 0);
  const [c] = await admin.db
    .insert(claims)
    .values({
      tenantId: NORTHWIND,
      clientId: client.id,
      patientId: p!.id,
      encounterId: e!.id,
      patientControlNumber: pcn,
      pcnSource: 'pm',
      status: 'submitted',
      mode: 'A',
      totalChargeCents: total,
      balanceCents: total,
    })
    .returning();
  const [v] = await admin.db
    .insert(claimVersions)
    .values({
      tenantId: NORTHWIND,
      clientId: client.id,
      claimId: c!.id,
      version: 1,
      payload: {},
      createdBy: 'automation:test',
    })
    .returning();
  await admin.db.insert(claimLines).values(
    lines.map((l, i) => ({
      tenantId: NORTHWIND,
      clientId: client.id,
      claimVersionId: v!.id,
      lineNumber: i + 1,
      code: l.code,
      chargeCents: l.chargeCents,
    })),
  );
  await admin.db.update(claims).set({ currentVersionId: v!.id }).where(eq(claims.id, c!.id));
  return c!.id;
}

type Line = { code: string; charge: number; paid: number; adj: remit.Adjustment[] };
function era(pcn: string, trace: string, lines: Line[]): remit.Remittance835 {
  const paid = lines.reduce((s, l) => s + l.paid, 0);
  return {
    payment: { method: 'ACH', amountCents: paid, paymentDate: '2026-11-10', traceNumber: trace },
    payer: { name: 'AETNA', id: 'SIMAETNA' },
    payee: { name: 'WILLAMETTE ORTHO', npi: null },
    claims: [
      {
        patientControlNumber: pcn,
        statusCode: paid ? '1' : '4',
        chargeCents: lines.reduce((s, l) => s + l.charge, 0),
        paidCents: paid,
        patientRespCents: lines
          .flatMap((l) => l.adj)
          .filter((a) => a.group === 'PR')
          .reduce((s, a) => s + a.amountCents, 0),
        payerClaimControlNumber: `PCCN-${pcn}`,
        frequencyCode: '1',
        patient: null,
        serviceDateFrom: '2026-10-27',
        adjustments: [],
        remarks: [],
        crossoverPayerName: null,
        lines: lines.map((l, i) => ({
          code: l.code,
          modifiers: [],
          chargeCents: l.charge,
          paidCents: l.paid,
          units: 1,
          allowedCents: null,
          lineControlNumber: `${pcn}-L${i + 1}`,
          serviceDate: '2026-10-27',
          adjustments: l.adj,
          remarks: [],
        })),
      },
    ],
    providerAdjustments: [],
  };
}

const PAID: Line = {
  code: '99213',
  charge: 13_500,
  paid: 7_500,
  adj: [
    { group: 'CO', carc: '45', amountCents: 3_500 },
    { group: 'PR', carc: '3', amountCents: 2_500 },
  ],
};
const goodPosting = (pcn: string, trace: string, line = 1) => ({
  traceNumber: trace,
  encounterExternalId: pcn,
  lineExternalId: `${pcn}-L${line}`,
  paidCents: 7_500,
  adjustments: [
    { pmAdjustmentCode: 'CONTR', amountCents: 3_500 },
    { pmAdjustmentCode: 'COPAY', amountCents: 2_500 },
  ],
  patientRespCents: 2_500,
  postedAt: '2026-11-10T12:00:00Z',
});

const ctx = { tenantId: NORTHWIND, clientId: client.id };
const tenantCtx = { ...ctx, connectionId: CONN };
const post = (items: Parameters<typeof storePmPostings>[2]) =>
  withTenant(app.db, { tenantId: NORTHWIND }, (tx) => storePmPostings(tx, tenantCtx, items));
const verify = (now = new Date()) =>
  withTenant(app.db, { tenantId: NORTHWIND }, (tx) => verifyInTx(tx, ctx, now));
async function ingest(r: remit.Remittance835) {
  const res = await ingestRemittance({ db: app.db, log }, { ...ctx, source: 'pm' }, r);
  expect(res.status).toBe('ingested');
  return res.remittanceId;
}
const remitStatus = async (id: string) =>
  (await admin.db.select({ s: remittances.status }).from(remittances).where(eq(remittances.id, id)))[0]!.s;
const lineStatuses = async (id: string) => {
  const rc = await admin.db
    .select({ id: remitClaims.id })
    .from(remitClaims)
    .where(eq(remitClaims.remittanceId, id));
  return (
    await admin.db
      .select({ s: remitLines.verifyStatus, d: remitLines.verifyDetail })
      .from(remitLines)
      .where(
        inArray(
          remitLines.remitClaimId,
          rc.map((r) => r.id),
        ),
      )
  ).map((l) => l.s);
};
const itemsFor = (remittanceId: string, type = 'posting_exception') =>
  admin.db
    .select()
    .from(workItems)
    .where(and(eq(workItems.remittanceId, remittanceId), eq(workItems.type, type)));

beforeAll(async () => {
  await seed(admin.db, 'verify-test-password-123');
}, 120_000);

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('posting match', () => {
  it('verifies a line the PM posted as the 835 says and reconciles the payment', async () => {
    await sentClaim('VER-1', [{ code: '99213', chargeCents: 13_500 }]);
    const id = await ingest(era('VER-1', 'TRC-VER-1', [PAID]));
    expect(await post([goodPosting('VER-1', 'TRC-VER-1')])).toEqual({ created: 1, unchanged: 0 });
    // A re-read of the same posting is not stored twice.
    expect(await post([goodPosting('VER-1', 'TRC-VER-1')])).toEqual({ created: 0, unchanged: 1 });
    const out = await verify();
    expect(out.reconciled).toBeGreaterThanOrEqual(1);
    expect(await remitStatus(id)).toBe('reconciled');
    expect(await lineStatuses(id)).toEqual(['verified']);
    expect(await itemsFor(id)).toEqual([]);
  });

  it('opens one item for a wrong code, keeps it single, and closes it when the PM fixes it', async () => {
    await sentClaim('VER-2', [{ code: '99213', chargeCents: 13_500 }]);
    const id = await ingest(era('VER-2', 'TRC-VER-2', [PAID]));
    const wrong = {
      ...goodPosting('VER-2', 'TRC-VER-2'),
      adjustments: [
        { pmAdjustmentCode: 'WO', amountCents: 3_500 },
        { pmAdjustmentCode: 'COPAY', amountCents: 2_500 },
      ],
    };
    await post([wrong]);
    await verify();
    await verify();
    expect(await remitStatus(id)).toBe('posting_mismatch');
    expect(await lineStatuses(id)).toEqual(['mismatch']);
    const items = await itemsFor(id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', reasonCode: 'POSTING_DIFFERS' });
    expect(items[0]!.summary).toContain('Adjustment CONTR');
    // The PM corrects the posting.
    await admin.db.delete(pmPostings).where(eq(pmPostings.traceNumber, 'TRC-VER-2'));
    await post([goodPosting('VER-2', 'TRC-VER-2')]);
    await verify();
    expect(await remitStatus(id)).toBe('reconciled');
    expect((await itemsFor(id))[0]).toMatchObject({
      status: 'resolved',
      resolvedBy: 'automation:remit.verify',
    });
  });

  it('waits for a payment the PM has not posted, then opens one item for it', async () => {
    await sentClaim('VER-3', [{ code: '99213', chargeCents: 13_500 }]);
    const id = await ingest(era('VER-3', 'TRC-VER-3', [PAID]));
    await verify();
    expect(await remitStatus(id)).toBe('verifying');
    expect(await lineStatuses(id)).toEqual(['pending']);
    expect(await itemsFor(id)).toEqual([]);
    await verify(new Date(Date.now() + 4 * 86_400_000));
    expect(await remitStatus(id)).toBe('posting_mismatch');
    const items = await itemsFor(id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reasonCode: 'NOT_POSTED', claimId: null });
    await post([goodPosting('VER-3', 'TRC-VER-3')]);
    await verify(new Date(Date.now() + 4 * 86_400_000));
    expect(await remitStatus(id)).toBe('reconciled');
    expect((await itemsFor(id))[0]!.status).toBe('resolved');
  });

  it('flags a denial the PM wrote off, and a line it skipped, in one item for the claim', async () => {
    await sentClaim('VER-4', [
      { code: '99213', chargeCents: 13_500 },
      { code: '29881', chargeCents: 250_000 },
    ]);
    const denied: Line = {
      code: '29881',
      charge: 250_000,
      paid: 0,
      adj: [{ group: 'CO', carc: '197', amountCents: 250_000 }],
    };
    const id = await ingest(era('VER-4', 'TRC-VER-4', [PAID, denied]));
    await post([
      {
        ...goodPosting('VER-4', 'TRC-VER-4', 2),
        paidCents: 0,
        adjustments: [{ pmAdjustmentCode: 'CONTR', amountCents: 250_000 }],
        patientRespCents: 0,
      },
    ]);
    await verify();
    expect((await lineStatuses(id)).sort()).toEqual(['mismatch', 'missing']);
    const items = await itemsFor(id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reasonCode: 'DENIAL_WRITTEN_OFF' });
    expect(items[0]!.summary).toMatch(
      /2 lines: .*Not posted.*Denial written off|2 lines: .*Denial written off.*Not posted/,
    );
  });

  it('asks once for a mapping when an adjustment has no PM code', async () => {
    for (const n of [5, 6]) {
      await sentClaim(`VER-${n}`, [{ code: '99213', chargeCents: 13_500 }]);
      const odd: Line = { ...PAID, adj: [PAID.adj[0]!, { group: 'OA', carc: '23', amountCents: 2_500 }] };
      await ingest(era(`VER-${n}`, `TRC-VER-${n}`, [odd]));
      await post([goodPosting(`VER-${n}`, `TRC-VER-${n}`)]);
    }
    await verify();
    const mapping = await admin.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.clientId, client.id),
          eq(workItems.type, 'mapping_needed'),
          eq(workItems.reasonCode, 'OA-23'),
        ),
      );
    expect(mapping).toHaveLength(1);
  });
});
