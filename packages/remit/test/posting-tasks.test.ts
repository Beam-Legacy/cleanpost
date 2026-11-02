/**
 * Manual posting (M-01, M-02, F-02): a client whose PM Cleanpost cannot read postings from gets one
 * posting task per payment, with a worksheet in the PM's codes; marking it posted reconciles the
 * payment on that person's word; a task that cannot be finished goes to the owner.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimLines,
  claims,
  claimVersions,
  createDatabase,
  encounters,
  manualTasks,
  memberships,
  patients,
  remitLines,
  remitClaims,
  remittances,
  users,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import type { remit } from '@cleanpost/domain';
import { createLogger } from '@cleanpost/log';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import { confirmPosting, escalatePosting, ingestRemittance } from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const log = createLogger({ name: 'posting-task-test' });
const client = CLIENTS.find((c) => c.name.startsWith('Riverbend'))!;
const ctx = { tenantId: NORTHWIND, clientId: client.id };

async function sentClaim(pcn: string) {
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
      dateOfService: '2026-10-14',
      status: 'claimed',
    })
    .returning();
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
      totalChargeCents: 18_000,
      balanceCents: 18_000,
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
  await admin.db.insert(claimLines).values({
    tenantId: NORTHWIND,
    clientId: client.id,
    claimVersionId: v!.id,
    lineNumber: 1,
    code: '90837',
    chargeCents: 18_000,
  });
  await admin.db.update(claims).set({ currentVersionId: v!.id }).where(eq(claims.id, c!.id));
  return c!.id;
}

const era = (pcn: string, trace: string): remit.Remittance835 => ({
  payment: { method: 'ACH', amountCents: 9_500, paymentDate: '2026-11-04', traceNumber: trace },
  payer: { name: 'OPTUM', id: null },
  payee: { name: 'RIVERBEND COUNSELING', npi: null },
  providerAdjustments: [],
  claims: [
    {
      patientControlNumber: pcn,
      statusCode: '1',
      chargeCents: 18_000,
      paidCents: 9_500,
      patientRespCents: 2_500,
      payerClaimControlNumber: `P-${pcn}`,
      frequencyCode: '1',
      patient: null,
      serviceDateFrom: '2026-10-14',
      adjustments: [],
      remarks: [],
      crossoverPayerName: null,
      lines: [
        {
          code: '90837',
          modifiers: [],
          chargeCents: 18_000,
          paidCents: 9_500,
          units: 1,
          allowedCents: 12_000,
          lineControlNumber: null,
          serviceDate: '2026-10-14',
          adjustments: [
            { group: 'CO', carc: '45', amountCents: 6_000 },
            { group: 'PR', carc: '2', amountCents: 2_500 },
          ],
          remarks: [],
        },
      ],
    },
  ],
});

let julia = '';
beforeAll(async () => {
  await seed(admin.db, 'posting-task-password-123');
  julia = (await admin.db.select().from(users).where(eq(users.email, 'julia@northwind.test')))[0]!.id;
}, 120_000);

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

const taskFor = async (remittanceId: string) =>
  await admin.db
    .select({ item: workItems, task: manualTasks })
    .from(workItems)
    .innerJoin(manualTasks, eq(manualTasks.workItemId, workItems.id))
    .where(and(eq(workItems.remittanceId, remittanceId), eq(workItems.type, 'manual_task')));

describe('manual posting', () => {
  it('opens one posting task per payment with a worksheet in the PM codes, and no duplicate', async () => {
    await sentClaim('RBC-E1');
    const res = await ingestRemittance(
      { db: app.db, log },
      { ...ctx, source: 'file' },
      era('RBC-E1', 'TRC-RBC-1'),
    );
    expect(res).toMatchObject({ status: 'ingested', matched: 1 });
    // The upload runs the posting match: the PM cannot be read, so a person posts it.
    const { verifyInTx } = await import('../src');
    await withTenant(app.db, { tenantId: NORTHWIND }, (tx) => verifyInTx(tx, ctx, new Date()));
    await withTenant(app.db, { tenantId: NORTHWIND }, (tx) => verifyInTx(tx, ctx, new Date()));
    const tasks = await taskFor(res.remittanceId);
    expect(tasks).toHaveLength(1);
    const { item, task } = tasks[0]!;
    expect(item).toMatchObject({ reasonCode: 'postPayment', status: 'open', claimId: null });
    expect(task.instructions.some((s) => s.startsWith('In SimplePractice, open payment posting'))).toBe(true);
    expect(task.instructions).toContain(
      'Worksheet: RBC-E1 · 2026-10-14 · 90837 · paid $95.00 · CONTR $60.00; COINS $25.00 · patient $25.00',
    );
    const [r] = await admin.db.select().from(remittances).where(eq(remittances.id, res.remittanceId));
    expect(r!.status).toBe('verifying');
  });

  it('marks it posted with the PM payment ID: the payment reconciles on that person’s word', async () => {
    const [r] = await admin.db.select().from(remittances).where(eq(remittances.traceNumber, 'TRC-RBC-1'));
    const item = (await taskFor(r!.id))[0]!.item;
    const call = (pmReference: string) =>
      withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
        confirmPosting(tx, { tenantId: NORTHWIND, userId: julia }, { itemId: item.id, pmReference }),
      );
    expect(await call('  ')).toEqual({ ok: false, reason: 'reference_required' });
    expect(await call('SP-PAY-88231')).toEqual({ ok: true });
    expect(await call('again')).toEqual({ ok: false, reason: 'not_open' });
    const [after] = await taskFor(r!.id);
    expect(after!.task).toMatchObject({ status: 'done', pmReference: 'SP-PAY-88231' });
    expect(after!.item).toMatchObject({
      status: 'resolved',
      resolution: 'Posted in the PM',
      resolvedBy: `user:${julia}`,
    });
    const [r2] = await admin.db.select().from(remittances).where(eq(remittances.id, r!.id));
    expect(r2!.status).toBe('reconciled');
    const [rc] = await admin.db.select().from(remitClaims).where(eq(remitClaims.remittanceId, r!.id));
    const lines = await admin.db.select().from(remitLines).where(eq(remitLines.remitClaimId, rc!.id));
    expect(lines.map((l) => l.verifyStatus)).toEqual(['confirmed']);
  });

  it('escalates a task that cannot be finished to the owner, with the reason', async () => {
    await sentClaim('RBC-E2');
    const res = await ingestRemittance(
      { db: app.db, log },
      { ...ctx, source: 'file' },
      era('RBC-E2', 'TRC-RBC-2'),
    );
    const { verifyInTx } = await import('../src');
    await withTenant(app.db, { tenantId: NORTHWIND }, (tx) => verifyInTx(tx, ctx, new Date()));
    const item = (await taskFor(res.remittanceId))[0]!.item;
    const out = await withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
      escalatePosting(
        tx,
        { tenantId: NORTHWIND, userId: julia },
        { itemId: item.id, reason: 'Claim or charge not found in the PM', note: 'No visit on that date' },
      ),
    );
    expect(out).toEqual({ ok: true });
    const [after] = await taskFor(res.remittanceId);
    const [owner] = await admin.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, NORTHWIND), eq(memberships.isOwner, true)));
    expect(after!.task.status).toBe('escalated');
    expect(after!.task.instructions.at(-1)).toBe(
      'Escalated: Claim or charge not found in the PM — No visit on that date',
    );
    expect(after!.item).toMatchObject({ priority: 1, assigneeId: owner!.userId, status: 'assigned' });
    expect(after!.item.summary).toMatch(/^Escalated: Claim or charge not found in the PM\./);
  });
});
