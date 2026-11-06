import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, createDatabase, users } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import type { policy } from '@cleanpost/domain';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND, PAYERS } from '@cleanpost/seed/world';
import { queryHash, recentRecords, searchRecords, type SearchContext } from '../src';

/** G-03 search over a small set of synthetic records in the seeded world (Northwind). */
const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const TODAY = '2026-11-06';
const LAKESIDE = CLIENTS[0]!;
const CASCADE = CLIENTS[1]!;
const AETNA = PAYERS.find((p) => p.name === 'Aetna')!.id;
const ids: Record<string, string> = {};

let adminCtx: SearchContext;
const asActor = (a: Partial<policy.Actor>): SearchContext => ({
  tenantId: NORTHWIND,
  userId: adminCtx.userId,
  actor: { ...adminCtx.actor, ...a },
});

async function patient(clientId: string, first: string, last: string, dob: string) {
  const r = await admin.db.execute<{ id: string }>(sql`
    insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
    values (${NORTHWIND}, ${clientId}, ${first}, ${last}, ${dob}::date, 'U') returning id`);
  return r.rows[0]!.id;
}

async function claim(clientId: string, patientId: string, pcn: string, dos: string) {
  const r = await admin.db.execute<{ id: string }>(sql`
    with e as (
      insert into encounters (tenant_id, client_id, patient_id, date_of_service, rendering_provider_id, location_id)
      values (${NORTHWIND}, ${clientId}, ${patientId}, ${dos}::date,
        (select id from providers where client_id = ${clientId} limit 1),
        (select id from locations where client_id = ${clientId} limit 1)) returning id)
    insert into claims (tenant_id, client_id, patient_id, encounter_id, payer_id, patient_control_number,
      mode, total_charge_cents, status)
    select ${NORTHWIND}, ${clientId}, ${patientId}, e.id, ${AETNA}, ${pcn}, 'A', 14500, 'rejected' from e
    returning id`);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  await seed(admin.db, 'search-test-password-123');
  const [u] = await admin.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'priya@northwind.test'));
  adminCtx = {
    tenantId: NORTHWIND,
    userId: u!.id,
    actor: { userId: u!.id, role: 'admin', isOwner: false, clientScope: 'all', clientIds: [] },
  };
  ids.ana = await patient(LAKESIDE.id, 'Ana', 'Riveraz', '1984-03-07');
  ids.diego = await patient(CASCADE.id, 'Diego', 'Riveraz', '2017-05-02');
  ids.claim = await claim(LAKESIDE.id, ids.ana, 'SRCH-26-004790', '2026-10-22');
  const rem = await admin.db.execute<{ id: string }>(sql`
    insert into remittances (tenant_id, client_id, payer_name, source, trace_number, payment_method,
      payment_amount_cents, payment_date)
    values (${NORTHWIND}, ${LAKESIDE.id}, 'Aetna', 'file', 'SRCH8810447', 'ACH', 210460, '2026-10-14') returning id`);
  ids.remittance = rem.rows[0]!.id;
  await admin.db.execute(sql`
    insert into remit_claims (tenant_id, client_id, remittance_id, claim_id, patient_control_number,
      payer_claim_control_number, claim_status_code, charge_cents, paid_cents)
    values (${NORTHWIND}, ${LAKESIDE.id}, ${ids.remittance}, ${ids.claim}, 'SRCH-26-004790', 'ICN99887766',
      '1', 14500, 9000)`);
});

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('search (G-03)', () => {
  it('finds patients by name as "Last, F." with an age, and their claims and remittances', async () => {
    const r = await searchRecords(app.db, adminCtx, 'riveraz', TODAY);
    expect(r.kind).toBe('name');
    expect(r.patients.map((p) => [p.name, p.age, p.dob, p.client])).toEqual([
      ['Riveraz, A.', 42, null, 'Lakeside Family Medicine'],
      ['Riveraz, D.', 9, null, CASCADE.name],
    ]);
    expect(r.claims).toEqual([
      expect.objectContaining({
        pcn: 'SRCH-26-004790',
        patient: 'Riveraz, A.',
        dateOfService: '2026-10-22',
        payer: 'Aetna',
        status: 'rejected',
      }),
    ]);
    expect(r.remittances).toEqual([
      expect.objectContaining({ trace: 'SRCH8810447', amountCents: 210460, patient: 'Riveraz, A.' }),
    ]);
  });

  it('narrows by "Last, First" and by first and last name in either order', async () => {
    expect((await searchRecords(app.db, adminCtx, 'Riveraz, A', TODAY)).patients.map((p) => p.name)).toEqual([
      'Riveraz, A.',
    ]);
    expect((await searchRecords(app.db, adminCtx, 'diego riv', TODAY)).patients.map((p) => p.name)).toEqual([
      'Riveraz, D.',
    ]);
  });

  it('shows the full date of birth only when the query was that date', async () => {
    const r = await searchRecords(app.db, adminCtx, '3/7/1984', TODAY);
    expect(r.kind).toBe('dob');
    expect(r.patients).toEqual([expect.objectContaining({ name: 'Riveraz, A.', dob: '1984-03-07' })]);
  });

  it('finds claims by control number or the payer claim number, and remittances by trace number', async () => {
    expect((await searchRecords(app.db, adminCtx, 'srch-26-0047', TODAY)).claims.map((c) => c.id)).toEqual([
      ids.claim,
    ]);
    expect((await searchRecords(app.db, adminCtx, 'ICN998877', TODAY)).claims.map((c) => c.id)).toEqual([
      ids.claim,
    ]);
    const t = await searchRecords(app.db, adminCtx, 'srch8810', TODAY);
    expect(t.remittances.map((x) => x.id)).toEqual([ids.remittance]);
    // LIKE's own characters are text, not wildcards.
    expect((await searchRecords(app.db, adminCtx, '%%%%', TODAY)).claims).toEqual([]);
  });

  it('finds clients by name', async () => {
    const r = await searchRecords(app.db, adminCtx, 'lakes', TODAY);
    expect(r.clients).toEqual([
      expect.objectContaining({ name: 'Lakeside Family Medicine', pmName: 'Tebra', mode: 'A' }),
    ]);
  });

  it("keeps to the person's clients and role", async () => {
    const biller = asActor({ role: 'biller', clientScope: 'list', clientIds: [LAKESIDE.id] });
    const b = await searchRecords(app.db, biller, 'riveraz', TODAY);
    expect(b.patients.map((p) => p.name)).toEqual(['Riveraz, A.']);
    const elsewhere = asActor({ role: 'biller', clientScope: 'list', clientIds: [CASCADE.id] });
    expect((await searchRecords(app.db, elsewhere, 'srch-26', TODAY)).claims).toEqual([]);
    // Viewers see claims and remittances but not patients.
    const viewer = asActor({ role: 'viewer', clientScope: 'all' });
    const v = await searchRecords(app.db, viewer, 'riveraz', TODAY);
    expect(v.patients).toEqual([]);
    expect((await searchRecords(app.db, viewer, 'srch-26', TODAY)).claims).toHaveLength(1);
  });

  it('records each search by its hash and counts, never its text', async () => {
    await searchRecords(app.db, adminCtx, 'Riveraz', TODAY);
    const [row] = await admin.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'search.performed'))
      .orderBy(sql`${auditEvents.at} desc`)
      .limit(1);
    expect(row!.metadata).toEqual({
      kind: 'name',
      queryHash: queryHash('riveraz'),
      found: { patients: 2, claims: 1, remittances: 1, clients: 0 },
    });
    expect(JSON.stringify(row!.metadata).toLowerCase()).not.toContain('riveraz');
    // Commands and one-letter queries search nothing.
    expect(await searchRecords(app.db, adminCtx, '> upload', TODAY)).toMatchObject({
      kind: 'command',
      patients: [],
    });
  });

  it('lists the records the person opened last, still in scope', async () => {
    await admin.db.insert(auditEvents).values([
      {
        tenantId: NORTHWIND,
        actor: `user:${adminCtx.userId}`,
        action: 'claim.viewed',
        entityType: 'claim',
        entityId: ids.claim,
        at: new Date(Date.now() - 1000),
      },
      {
        tenantId: NORTHWIND,
        actor: `user:${adminCtx.userId}`,
        action: 'patient.viewed',
        entityType: 'patient',
        entityId: ids.diego,
      },
    ]);
    const recent = await recentRecords(app.db, adminCtx);
    expect(recent.slice(0, 2)).toEqual([
      { type: 'patient', id: ids.diego, label: 'Riveraz, D.', detail: CASCADE.name },
      { type: 'claim', id: ids.claim, label: 'SRCH-26-004790', detail: 'Riveraz, A. · Aetna' },
    ]);
    const scoped = await recentRecords(
      app.db,
      asActor({ role: 'biller', clientScope: 'list', clientIds: [LAKESIDE.id] }),
    );
    expect(scoped.map((r) => r.id)).not.toContain(ids.diego);
  });
});
