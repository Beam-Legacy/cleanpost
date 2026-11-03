import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuid } from 'uuid';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import {
  getAging,
  getDenialsReport,
  getOverview,
  getPayerResults,
  getTeamReport,
  type ReportScope,
} from '../src';

/**
 * M4 acceptance: report figures match direct computations. A small world with every number known:
 * client A has three October claims (paid, denied CO-16 after a person approved it, rejected
 * first then accepted), client B one claim accepted on Aug 1 and still open; one 835 paid Oct 20.
 */
const { adminUrl, url } = testDatabaseUrls();
let admin: DatabaseHandle;
let app: DatabaseHandle;

const T = uuid();
const A = uuid();
const B = uuid();
const U = uuid();
const PAYER = uuid();
const OCT = { from: '2026-10-01', to: '2026-10-31' };
const TODAY = '2026-11-03';
const noonPt = (ymd: string) => `${ymd}T19:00:00Z`;
const scope: ReportScope = { tenantId: T, clients: 'all' };

async function claim(
  client: string,
  dos: string,
  charge: number,
  status: string,
  balance: number,
  events: [string, string, string?][],
) {
  const patient = uuid();
  const encounter = uuid();
  const id = uuid();
  await admin.db.execute(sql`insert into patients (id, tenant_id, client_id, first_name, last_name, dob)
    values (${patient}, ${T}, ${client}, 'Test', 'Patient', '1980-01-01')`);
  await admin.db.execute(sql`insert into encounters (id, tenant_id, client_id, patient_id, date_of_service)
    values (${encounter}, ${T}, ${client}, ${patient}, ${dos})`);
  await admin.db
    .execute(sql`insert into claims (id, tenant_id, client_id, patient_id, encounter_id, payer_id, mode,
    status, total_charge_cents, balance_cents)
    values (${id}, ${T}, ${client}, ${patient}, ${encounter}, ${PAYER}, 'A', ${status}, ${charge}, ${balance})`);
  for (const [type, day, actor] of events)
    await admin.db
      .execute(sql`insert into claim_events (tenant_id, client_id, claim_id, type, actor, occurred_at)
      values (${T}, ${client}, ${id}, ${type}, ${actor ?? 'automation:test'}, ${noonPt(day)})`);
  return id;
}

beforeAll(async () => {
  admin = createDatabase(adminUrl, { max: 1 });
  app = createDatabase(url, { max: 2 });
  await admin.db.execute(sql`insert into tenants (id, name) values (${T}, 'Reports Test Billing')`);
  await admin.db.execute(
    sql`insert into clients (id, tenant_id, name) values (${A}, ${T}, 'Client A'), (${B}, ${T}, 'Client B')`,
  );
  await admin.db.execute(sql`insert into payers (id, name) values (${PAYER}, 'Test Payer')`);
  await admin.db.execute(
    sql`insert into users (id, name, email) values (${U}, 'Test Biller', ${`${U}@reports.test`})`,
  );
  await admin.db.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${T}, ${U}, 'biller')`,
  );

  const a1 = await claim(A, '2026-10-05', 10_000, 'paid', 0, [
    ['released', '2026-10-06'],
    ['ack_277ca', '2026-10-06'],
  ]);
  const a2 = await claim(A, '2026-10-07', 20_000, 'denied', 20_000, [
    ['approved', '2026-10-08', `user:${U}`],
    ['released', '2026-10-08'],
    ['ack_277ca', '2026-10-09'],
  ]);
  await claim(A, '2026-10-10', 5_000, 'submitted', 5_000, [
    ['released', '2026-10-11'],
    ['rejected', '2026-10-11'],
    ['ack_277ca', '2026-10-12'],
  ]);
  await claim(B, '2026-07-30', 30_000, 'accepted', 30_000, [
    ['released', '2026-07-31'],
    ['ack_277ca', '2026-08-01'],
  ]);

  const r = uuid();
  await admin.db
    .execute(sql`insert into remittances (id, tenant_id, client_id, payer_name, source, trace_number,
    payment_method, payment_amount_cents, payment_date, status, created_at)
    values (${r}, ${T}, ${A}, 'Test Payer', 'pm', 'TRACE-1', 'ACH', 8000, '2026-10-20', 'reconciled', ${noonPt('2026-10-20')})`);
  const line = async (
    claimId: string,
    charge: number,
    paid: number,
    verify: string | null,
    adj: [string, string, number][],
  ) => {
    const rc = uuid();
    const l = uuid();
    await admin.db.execute(sql`insert into remit_claims (id, tenant_id, client_id, remittance_id, claim_id,
      claim_status_code, charge_cents, paid_cents, patient_resp_cents)
      values (${rc}, ${T}, ${A}, ${r}, ${claimId}, ${paid ? '1' : '4'}, ${charge}, ${paid}, 0)`);
    await admin.db
      .execute(sql`insert into remit_lines (id, tenant_id, client_id, remit_claim_id, code, charge_cents,
      paid_cents, verify_status)
      values (${l}, ${T}, ${A}, ${rc}, '99213', ${charge}, ${paid}, ${verify})`);
    for (const [group, carc, cents] of adj)
      await admin.db.execute(sql`insert into remit_adjustments (tenant_id, client_id, remit_line_id,
        group_code, carc, amount_cents)
        values (${T}, ${A}, ${l}, ${group}, ${carc}, ${cents})`);
  };
  await line(a1, 10_000, 8_000, 'verified', [
    ['CO', '45', 1_500],
    ['PR', '3', 500],
  ]);
  await line(a2, 20_000, 0, null, [['CO', '16', 20_000]]);

  const item = (fields: Record<string, unknown>) =>
    admin.db
      .execute(sql`insert into work_items (tenant_id, client_id, type, reason_code, summary, due_at, status,
      created_at, resolved_at, resolved_by, assignee_id)
      values (${T}, ${A}, 'denial', 'x', 'test item', ${fields.due as string}, ${fields.status as string},
        ${fields.created as string}, ${(fields.resolved as string) ?? null}, ${(fields.by as string) ?? null},
        ${(fields.assignee as string) ?? null})`);
  await item({
    due: '2026-10-11T19:00:00Z',
    status: 'resolved',
    created: '2026-10-10T16:00:00Z',
    resolved: '2026-10-10T20:00:00Z',
    by: `user:${U}`,
  });
  await item({
    due: '2026-10-11T19:00:00Z',
    status: 'resolved',
    created: '2026-10-10T16:00:00Z',
    resolved: '2026-10-12T20:00:00Z',
    by: 'automation:test',
  });
  await item({ due: '2026-10-01T19:00:00Z', status: 'open', created: '2026-09-30T16:00:00Z', assignee: U });
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('report figures (RP-01 to RP-05)', () => {
  it('RP-01: the KPIs, worked out by hand and by direct SQL', async () => {
    const o = await getOverview(app.db, scope, OCT, undefined, TODAY);
    const k = o.kpis;
    const direct = await admin.db.execute<{ paid: string; ar: string }>(sql`
      select (select sum(rc.paid_cents) from remit_claims rc join remittances r on r.id = rc.remittance_id
          where r.tenant_id = ${T} and r.payment_date between '2026-10-01' and '2026-10-31') as paid,
        (select sum(balance_cents) from claims where tenant_id = ${T}
          and status in ('submitted', 'accepted', 'denied', 'rejected')) as ar`);
    expect(k.collectionsCents).toBe(Number(direct.rows[0]!.paid));
    expect(k.inputs.openArCents).toBe(Number(direct.rows[0]!.ar));
    expect(k.collectionsCents).toBe(8_000);
    expect(k.chargesCents).toBe(35_000); // October dates of service: 10,000 + 20,000 + 5,000
    expect(k.claims).toBe(3);
    expect(k.adjustmentsCents).toBe(21_500); // CO-45 1,500 + CO-16 20,000 (PR is the patient's)
    expect(k.inputs.firstPass).toEqual({ accepted: 2, total: 3 }); // A3's first answer was a rejection
    expect(k.firstPass).toBe(66.7);
    expect(k.inputs.lines).toEqual({ denied: 1, total: 2 });
    expect(k.denialRate).toBe(50);
    expect(k.deniedCents).toBe(20_000);
    expect(k.inputs.released).toEqual({ auto: 2, total: 3 }); // A2 was approved by a person first
    expect(k.inputs.era).toEqual({ clean: 1, total: 2 });
    expect(k.chargeToSubmission).toBe(1);
    // Open A/R 55,000 over (35,000 charged in the last 90 days / 90).
    expect(k.inputs.openArCents).toBe(55_000);
    expect(k.inputs.charges90Cents).toBe(35_000);
    expect(k.daysInAr).toBe(141.4);
    expect(o.weekly.find((w) => w.week === '2026-10-05')).toMatchObject({ accepted: 2, total: 3 });
  });

  it('keeps to the scope: a user who sees only client B sees none of client A', async () => {
    const o = await getOverview(app.db, { tenantId: T, clients: [B] }, OCT, undefined, TODAY);
    expect(o.clients.map((c) => c.client.name)).toEqual(['Client B']);
    expect(o.kpis.collectionsCents).toBe(0);
    expect(o.kpis.inputs.openArCents).toBe(30_000);
  });

  it('RP-03: ages open balances from the first acceptance, and flags a payer over 10% past 90 days', async () => {
    const a = await getAging(app.db, scope, { view: 'insurance', groupBy: 'payer' }, TODAY);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ label: 'Test Payer', totalCents: 55_000, claims: 3, slow: true });
    expect(a.rows[0]!.buckets).toEqual({
      '0–30': 25_000,
      '31–60': 0,
      '61–90': 0,
      '91–120': 30_000,
      '120+': 0,
    });
  });

  it('RP-02 and RP-04: payers and denial codes', async () => {
    const p = await getPayerResults(app.db, scope, A, OCT);
    expect(p.rows).toEqual([]); // under 20 claims: rolled into Other payers
    expect(p.other).toEqual({ payers: 1, paidCents: 8_000 });
    const d = await getDenialsReport(app.db, scope, OCT);
    expect(d.lines).toBe(1);
    expect(d.deniedCents).toBe(20_000);
    expect(d.codes).toEqual([
      expect.objectContaining({
        code: 'CO-16',
        group: 'Missing information',
        lines: 1,
        cents: 20_000,
        topPayer: 'Test Payer',
      }),
    ]);
  });

  it('RP-05: resolved by people and by automation, time to resolve, open and overdue', async () => {
    const t = await getTeamReport(app.db, scope, OCT, new Date(noonPt(TODAY)));
    expect(t.resolved).toBe(2);
    expect(t.byAutomation).toBe(1);
    expect(t.medianHours).toBe(4);
    expect(t.billers).toEqual([
      expect.objectContaining({
        name: 'Test Biller',
        resolved: 1,
        medianHours: 4,
        pastSla: 0,
        openNow: 1,
        overdueNow: 1,
      }),
    ]);
  });
});
