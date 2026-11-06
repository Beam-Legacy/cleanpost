import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuid } from 'uuid';
import { createDatabase, usageRecords, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { meterUsageDay, usageForPeriod } from '../src';

/**
 * Usage metering (S-11 rules): a claim counts once, on the day Cleanpost first released it; a
 * correction released again does not count; a claim the PM sent without Cleanpost does not count.
 */
const { adminUrl, url } = testDatabaseUrls();
let admin: DatabaseHandle;
let app: DatabaseHandle;
const T = uuid();
const X = uuid();
const Y = uuid();
const U = uuid();
const noonPt = (ymd: string) => `${ymd}T19:00:00Z`;

async function claim(client: string, mode: string, releases: [string, string][]) {
  const patient = uuid();
  const encounter = uuid();
  const id = uuid();
  await admin.db.execute(sql`insert into patients (id, tenant_id, client_id, first_name, last_name, dob)
    values (${patient}, ${T}, ${client}, 'Test', 'Patient', '1980-01-01')`);
  await admin.db.execute(sql`insert into encounters (id, tenant_id, client_id, patient_id, date_of_service)
    values (${encounter}, ${T}, ${client}, ${patient}, '2026-10-01')`);
  await admin.db
    .execute(sql`insert into claims (id, tenant_id, client_id, patient_id, encounter_id, mode, status,
    total_charge_cents, balance_cents) values (${id}, ${T}, ${client}, ${patient}, ${encounter}, ${mode}, 'accepted', 10000, 10000)`);
  for (const [day, via] of releases)
    await admin.db
      .execute(sql`insert into claim_events (tenant_id, client_id, claim_id, type, actor, occurred_at, payload)
      values (${T}, ${client}, ${id}, 'released', 'automation:test', ${noonPt(day)}, ${JSON.stringify({ via })}::jsonb)`);
  return id;
}

beforeAll(async () => {
  admin = createDatabase(adminUrl, { max: 1 });
  app = createDatabase(url, { max: 2 });
  await admin.db.execute(sql`insert into tenants (id, name) values (${T}, 'Usage Test Billing')`);
  await admin.db.execute(
    sql`insert into clients (id, tenant_id, name) values (${X}, ${T}, 'Client X'), (${Y}, ${T}, 'Client Y')`,
  );
  await admin.db.execute(
    sql`insert into users (id, name, email) values (${U}, 'Admin', ${`${U}@usage.test`})`,
  );
  // Released by Cleanpost on Oct 10, corrected and released again on Oct 20: counts once, Oct 10.
  await claim(X, 'A', [
    ['2026-10-10', 'adapter'],
    ['2026-10-20', 'adapter'],
  ]);
  // Approved in Cleanpost, sent at the PM's batch: counts.
  await claim(X, 'A', [['2026-10-10', 'pm_schedule']]);
  // The PM sent it without Cleanpost: does not count.
  await claim(Y, 'A', [['2026-10-10', 'pm_outside_cleanpost']]);
  // Released today: not metered yet, counted live.
  await claim(Y, 'A', [['2026-11-03', 'adapter']]);
});

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('usage metering', () => {
  it('meters a claim once, at its first release through Cleanpost, and can run again', async () => {
    expect(await meterUsageDay(app.db, T, '2026-10-10')).toBe(1);
    expect(await meterUsageDay(app.db, T, '2026-10-10')).toBe(1);
    expect(await meterUsageDay(app.db, T, '2026-10-20')).toBe(0);
    const rows = await admin.db.select().from(usageRecords).where(eq(usageRecords.tenantId, T));
    expect(rows.map((r) => [r.clientId, r.date, r.claimsReleased, r.claimsByMode])).toEqual([
      [X, '2026-10-10', 2, { A: 2, B: 0, C: 0 }],
    ]);
  });

  it('shows a period by client, with today counted live (S-11)', async () => {
    const u = await usageForPeriod(
      app.db,
      { tenantId: T, userId: U },
      '2026-10-01',
      '2026-11-30',
      '2026-11-03',
    );
    expect(u).toEqual({
      rows: [
        { clientId: X, clientName: 'Client X', released: 2, byMode: { A: 2, B: 0, C: 0 } },
        { clientId: Y, clientName: 'Client Y', released: 1, byMode: { A: 1, B: 0, C: 0 } },
      ],
      total: 3,
      byMode: { A: 3, B: 0, C: 0 },
      includesToday: true,
    });
    const october = await usageForPeriod(
      app.db,
      { tenantId: T, userId: U },
      '2026-10-01',
      '2026-10-31',
      '2026-11-03',
    );
    expect(october.total).toBe(2);
    expect(october.includesToday).toBe(false);
  });
});
