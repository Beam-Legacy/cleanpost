import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claims,
  clients,
  connections,
  createDatabase,
  notificationRules,
  notifications,
  userPreferences,
  users,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { memoryMailer } from '@cleanpost/email';
import { createLogger } from '@cleanpost/log';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND, PAYERS } from '@cleanpost/seed/world';
import { scanForPhi } from '@cleanpost/testing';
import { listActiveTenants, sweepTenant, type NotifyDeps } from '../src';

/** The notification sweep against the seeded world (Northwind; times in Pacific). */
const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const mailer = memoryMailer();
const deps: NotifyDeps = {
  db: app.db,
  log: createLogger({ name: 'notify-test' }),
  mailer,
  appUrl: 'https://app.cleanpost.test',
};

// Thursday Nov 5, 2026, 11:00 am Pacific.
const NOW = new Date('2026-11-05T19:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const LAKESIDE = CLIENTS[0]!;
const CASCADE = CLIENTS[1]!;
const AETNA = PAYERS.find((p) => p.name === 'Aetna')!.id;

const ids: Record<string, string> = {};
const people: Record<string, string> = {};
const sentSince = (n: number) => mailer.sent.slice(n);

async function userId(email: string) {
  const [u] = await admin.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return u!.id;
}

async function newClaim(deadline: string, pcn: string) {
  const r = await admin.db.execute<{ id: string }>(sql`
    with p as (
      insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
      values (${NORTHWIND}, ${LAKESIDE.id}, 'Test', 'Patient', '1980-01-01', 'F') returning id),
    e as (
      insert into encounters (tenant_id, client_id, patient_id, date_of_service, rendering_provider_id, location_id)
      select ${NORTHWIND}, ${LAKESIDE.id}, p.id, '2026-08-01',
        (select id from providers where client_id = ${LAKESIDE.id} limit 1),
        (select id from locations where client_id = ${LAKESIDE.id} limit 1)
      from p returning id, patient_id)
    insert into claims (tenant_id, client_id, patient_id, encounter_id, payer_id, patient_control_number,
      mode, total_charge_cents, status, filing_deadline)
    select ${NORTHWIND}, ${LAKESIDE.id}, e.patient_id, e.id, ${AETNA}, ${pcn}, 'A', 14500, 'submitted', ${deadline}::date
    from e returning id`);
  return r.rows[0]!.id;
}

async function item(values: Partial<typeof workItems.$inferInsert> & { type: string }) {
  const [row] = await admin.db
    .insert(workItems)
    .values({
      tenantId: NORTHWIND,
      clientId: LAKESIDE.id,
      priority: 2,
      dueAt: hours(24),
      reasonCode: 'TEST',
      summary: 'Test item',
      ...values,
    })
    .returning({ id: workItems.id });
  return row!.id;
}

const mine = async (email: string, type?: string) =>
  admin.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, people[email]!),
        type ? eq(notifications.type, type) : sql`true`,
        sql`${notifications.dedupeKey} is not null`,
      ),
    );

beforeAll(async () => {
  await seed(admin.db, 'notify-test-password-123');
  for (const e of [
    'julia@northwind.test',
    'priya@northwind.test',
    'dana@northwind.test',
    'marcus@northwind.test',
  ])
    people[e] = await userId(e);

  // A failed connection with its open sync_failure item.
  const [conn] = await admin.db.select().from(connections).where(eq(connections.clientId, LAKESIDE.id));
  ids.conn = conn!.id;
  await admin.db.update(connections).set({ status: 'failed' }).where(eq(connections.id, conn!.id));
  await item({
    type: 'sync_failure',
    priority: 1,
    connectionId: conn!.id,
    summary: 'Lakeside: Tebra connection failed. Tebra refused the saved sign-in.',
  });

  // An 835 off by $800 (over the $500 default).
  const rem = await admin.db.execute<{ id: string }>(sql`
    insert into remittances (tenant_id, client_id, payer_name, source, trace_number, payment_method,
      payment_amount_cents, payment_date, status)
    values (${NORTHWIND}, ${LAKESIDE.id}, 'Aetna', 'file', 'NOTIFY-T1', 'CHK', 120000, '2026-11-04', 'out_of_balance')
    returning id`);
  ids.remittance = rem.rows[0]!.id;
  await item({ type: 'out_of_balance', remittanceId: ids.remittance, amountCents: -80_000 });

  // Claims the payer has not accepted: one 2 days from its filing limit, one 10 days.
  ids.near = await newClaim('2026-11-07', 'NOTIFY-PCN-1');
  ids.later = await newClaim('2026-11-15', 'NOTIFY-PCN-2');

  // Denials: one over the $1,000 default, assigned to Dana; one under.
  ids.bigDenial = await item({
    type: 'denial',
    amountCents: 150_000,
    assigneeId: people['dana@northwind.test'],
    claimId: ids.near,
  });
  ids.smallDenial = await item({ type: 'denial', amountCents: 50_000 });

  // A priority 1 claim review past its SLA, assigned to Marcus.
  ids.late = await item({
    type: 'claim_review',
    priority: 1,
    dueAt: hours(-1),
    assigneeId: people['marcus@northwind.test'],
  });

  // Cascade went live an hour ago and its first sync finished.
  const [cconn] = await admin.db.select().from(connections).where(eq(connections.clientId, CASCADE.id));
  await admin.db
    .update(clients)
    .set({ goLiveAt: hours(-1), onboarding: null })
    .where(eq(clients.id, CASCADE.id));
  await admin.db.execute(sql`
    insert into sync_runs (tenant_id, client_id, connection_id, operation, started_at, finished_at, status, counts)
    values (${NORTHWIND}, ${CASCADE.id}, ${cconn!.id}, 'pullCharges', ${hours(-0.5)}, ${hours(-0.4)}, 'succeeded', '{"new": 42}'),
           (${NORTHWIND}, ${CASCADE.id}, ${cconn!.id}, 'pullPatientsAndCoverage', ${hours(-0.5)}, ${hours(-0.45)}, 'succeeded', '{"new": 30}')`);
});

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('notification sweep', () => {
  let first = 0;

  it('lists the active companies through the security-definer function', async () => {
    expect(await listActiveTenants(app.db)).toEqual(expect.arrayContaining([NORTHWIND]));
  });

  it('opens timely-filing items, notifies each audience, and sends urgent emails and digests', async () => {
    first = mailer.sent.length;
    const r = await sweepTenant(deps, NORTHWIND, NOW);
    expect(r.itemsOpened).toBe(2);

    const tf = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'timely_filing_risk'), eq(workItems.claimId, ids.near!)));
    expect(tf[0]).toMatchObject({ priority: 1, status: 'open', reasonCode: 'FILING_LIMIT_NEAR' });
    expect(tf[0]!.summary).toBe('Must reach Aetna by Nov 7 (2 days left).');

    // Admins: the connection, the 835, the claim within 3 days (not the one 10 days out), the big denial.
    const julia = await mine('julia@northwind.test');
    const types = julia.map((n) => n.type).sort();
    expect(types).toEqual(
      expect.arrayContaining([
        'client_live',
        'connection_failed',
        'large_denial',
        'out_of_balance',
        'timely_filing',
      ]),
    );
    expect(julia.filter((n) => n.type === 'timely_filing')).toHaveLength(1);
    expect(julia.filter((n) => n.type === 'large_denial')).toHaveLength(1);
    expect(julia.find((n) => n.type === 'connection_failed')).toMatchObject({
      link: `/integrations/${ids.conn}`,
      summary: 'Lakeside Family Medicine: Tebra connection failed',
      urgent: true,
      inApp: true,
    });
    expect(julia.find((n) => n.type === 'out_of_balance')).toMatchObject({ detail: 'Off by $800.00' });
    // A priority 1 item past SLA goes to its assignee only.
    expect(julia.some((n) => n.type === 'sla_breach')).toBe(false);
    expect((await mine('marcus@northwind.test', 'sla_breach')).map((n) => n.link)).toEqual([
      `/work?item=${ids.late}`,
    ]);
    // The assignee of the big denial hears about it; no one about the small one.
    expect(await mine('dana@northwind.test', 'large_denial')).toHaveLength(1);
    // Everyone on Cascade hears it went live.
    expect(await mine('marcus@northwind.test', 'client_live')).toHaveLength(1);

    const sent = sentSince(first);
    const urgent = sent.filter((e) => e.template === 'E-05');
    // Connection, out of balance and timely filing email admins by default; denials and SLA do not.
    expect(
      urgent
        .filter((e) => e.to === 'julia@northwind.test')
        .map((e) => e.content.subject)
        .sort(),
    ).toEqual([
      'Action needed: Lakeside Family Medicine: a claim is near its filing limit with Aetna',
      'Action needed: Lakeside Family Medicine: an 835 from Aetna is out of balance',
      'Action needed: Tebra connection failed for Lakeside Family Medicine',
    ]);
    expect(urgent.some((e) => e.to === 'marcus@northwind.test')).toBe(false);
    expect(urgent[0]!.content.text).toContain(`https://app.cleanpost.test/`);

    // E-06 once Cascade's first sync finished, with its counts, to the admins.
    const live = sent.filter((e) => e.template === 'E-06');
    expect(live.map((e) => e.to).sort()).toEqual(['julia@northwind.test', 'priya@northwind.test']);
    expect(live[0]!.content.text).toContain('First sync: 42 encounters, 30 patients updated');

    // E-04: 11 am is past the 7:30 digest time, so each person with something to say gets one.
    const digests = sent.filter((e) => e.template === 'E-04');
    expect(digests.map((e) => e.to)).toEqual(
      expect.arrayContaining(['dana@northwind.test', 'marcus@northwind.test']),
    );
    const dana = digests.find((e) => e.to === 'dana@northwind.test')!;
    expect(dana.content.subject).toMatch(/^Your Cleanpost queue: \d+ due today, \d+ overdue$/);
    expect(dana.content.text).toContain('Good morning, Dana');
    for (const e of sent)
      expect(scanForPhi(e.content.text).filter((f) => f.kind !== 'synthetic_name')).toEqual([]);
  });

  it('does not repeat itself: no new rows, no email within 4 hours, one digest a day', async () => {
    const before = mailer.sent.length;
    const r = await sweepTenant(deps, NORTHWIND, hours(1));
    expect(r).toMatchObject({ itemsOpened: 0, notified: 0, alertEmails: 0, digests: 0, liveEmails: 0 });
    expect(mailer.sent.length).toBe(before);
    expect(await mine('julia@northwind.test', 'connection_failed')).toHaveLength(1);
  });

  it('emails again after 4 hours while the problem lasts, but waits through quiet hours (except timely filing)', async () => {
    let before = mailer.sent.length;
    await sweepTenant(deps, NORTHWIND, hours(4));
    const again = sentSince(before).filter((e) => e.template === 'E-05' && e.to === 'julia@northwind.test');
    expect(again).toHaveLength(3);

    // 9 pm Pacific is in the default quiet hours (8 pm to 7 am).
    before = mailer.sent.length;
    await sweepTenant(deps, NORTHWIND, hours(10));
    const quiet = sentSince(before).filter((e) => e.template === 'E-05' && e.to === 'julia@northwind.test');
    expect(quiet.map((e) => e.content.subject)).toEqual([
      'Action needed: Lakeside Family Medicine: a claim is near its filing limit with Aetna',
    ]);
  });

  it('resolves the timely-filing item once the payer accepts the claim', async () => {
    await admin.db.update(claims).set({ status: 'accepted' }).where(eq(claims.id, ids.near!));
    const r = await sweepTenant(deps, NORTHWIND, hours(11));
    expect(r.itemsResolved).toBe(1);
    const [tf] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'timely_filing_risk'), eq(workItems.claimId, ids.near!)));
    expect(tf).toMatchObject({ status: 'resolved', resolution: 'Accepted by the payer' });
  });

  it('does not reopen a timely-filing item a person resolved', async () => {
    await sweepTenant(deps, NORTHWIND, hours(11));
    const open = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'timely_filing_risk'), eq(workItems.claimId, ids.later!)));
    expect(open.filter((w) => w.status !== 'resolved')).toHaveLength(1);
    await admin.db
      .update(workItems)
      .set({ status: 'resolved', resolvedBy: 'user:someone', resolution: 'Documented with payer' })
      .where(eq(workItems.id, open.find((w) => w.status !== 'resolved')!.id));
    const r = await sweepTenant(deps, NORTHWIND, hours(11.5));
    expect(r.itemsOpened).toBe(0);
    const after = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.type, 'timely_filing_risk'), eq(workItems.claimId, ids.later!)));
    expect(after.filter((w) => w.status !== 'resolved')).toHaveLength(0);
  });

  it("follows the company's settings and the person's own switches", async () => {
    // Denials go to the digest only, from $1,200; a $1,300 denial is recorded but not shown in-app.
    await admin.db.insert(notificationRules).values({
      tenantId: NORTHWIND,
      eventType: 'large_denial',
      channels: ['digest'],
      thresholdCents: 120_000,
    });
    const big = await item({ type: 'denial', amountCents: 130_000 });
    await sweepTenant(deps, NORTHWIND, hours(12));
    const [row] = await admin.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, people['priya@northwind.test']!), eq(notifications.entityId, big)));
    expect(row).toMatchObject({ inApp: false, summary: 'Denial over $1,200.00: Lakeside Family Medicine' });

    // Priya turns her digest off: the next morning she gets none; Julia does.
    await admin.db
      .insert(userPreferences)
      .values({ tenantId: NORTHWIND, userId: people['priya@northwind.test']!, digestEmail: false })
      .onConflictDoUpdate({
        target: [userPreferences.tenantId, userPreferences.userId],
        set: { digestEmail: false },
      });
    const before = mailer.sent.length;
    await sweepTenant(deps, NORTHWIND, hours(21)); // Friday 8 am Pacific
    const digests = sentSince(before)
      .filter((e) => e.template === 'E-04')
      .map((e) => e.to);
    expect(digests).toContain('julia@northwind.test');
    expect(digests).not.toContain('priya@northwind.test');
  });
});
