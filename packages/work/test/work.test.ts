import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, createDatabase, notifications, users, withTenant, workItems } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import {
  assignItem,
  reopenItem,
  resolveItem,
  snoozeItem,
  unassignItemsOf,
  wakeDueItems,
  wakeItem,
} from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
let userId = '';
const ctx = () => ({ tenantId: NORTHWIND, userId });

async function newItem(type = 'claim_review', clientId = CLIENTS[0]!.id) {
  const [row] = await admin.db
    .insert(workItems)
    .values({
      tenantId: NORTHWIND,
      clientId,
      type,
      priority: 2,
      dueAt: new Date(Date.now() + 24 * 3_600_000),
      reasonCode: 'TEST',
      summary: 'Test item',
    })
    .returning();
  return row!;
}

const get = async (id: string) => (await admin.db.select().from(workItems).where(eq(workItems.id, id)))[0]!;

beforeAll(async () => {
  await seed(admin.db, 'work-test-password-123');
  const [u] = await admin.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'dana@northwind.test'));
  userId = u!.id;
});

afterAll(async () => {
  await Promise.all([admin.close(), app.close()]);
});

describe('work item actions', () => {
  it('snoozes without moving the SLA, and Undo wakes it', async () => {
    const item = await newItem();
    const until = new Date(Date.now() + 3 * 3_600_000);
    expect(await snoozeItem(app.db, ctx(), item.id, until)).toEqual({ ok: true });
    const snoozed = await get(item.id);
    expect(snoozed).toMatchObject({ status: 'snoozed', dueAt: item.dueAt });
    expect(snoozed.snoozedUntil?.toISOString()).toBe(until.toISOString());
    expect(await wakeItem(app.db, ctx(), item.id)).toEqual({ ok: true });
    expect(await get(item.id)).toMatchObject({ status: 'open', snoozedUntil: null });
  });

  it('refuses a snooze in the past or more than 30 days out', async () => {
    const item = await newItem();
    expect(await snoozeItem(app.db, ctx(), item.id, new Date(Date.now() - 1000))).toEqual({
      ok: false,
      reason: 'past',
    });
    expect(await snoozeItem(app.db, ctx(), item.id, new Date(Date.now() + 40 * 86_400_000))).toEqual({
      ok: false,
      reason: 'too_far',
    });
  });

  it('resolves with a reason (W-07), records who did it, and Undo reopens it', async () => {
    const item = await newItem();
    expect(await resolveItem(app.db, ctx(), item.id, { reason: 'Other' })).toEqual({
      ok: false,
      reason: 'note_required',
    });
    expect(await resolveItem(app.db, ctx(), item.id, { reason: 'Other', note: 'Handled by phone' })).toEqual({
      ok: true,
    });
    expect(await get(item.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: `user:${userId}`,
      resolution: 'Other: Handled by phone',
    });
    const [audit] = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, item.id), eq(auditEvents.action, 'work_item.resolved')));
    expect(audit!.metadata).toMatchObject({ reason: 'Other', hasNote: true });
    expect(JSON.stringify(audit!.metadata)).not.toContain('phone');
    expect(await reopenItem(app.db, ctx(), item.id)).toEqual({ ok: true });
    expect(await get(item.id)).toMatchObject({ status: 'open', resolvedBy: null, resolution: null });
  });

  it('refuses moves the state machine does not allow', async () => {
    const item = await newItem();
    expect(await wakeItem(app.db, ctx(), item.id)).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(await reopenItem(app.db, ctx(), item.id)).toEqual({ ok: false, reason: 'invalid_transition' });
  });

  it('wakes snoozed items whose time has come, as automation', async () => {
    const item = await newItem();
    await snoozeItem(app.db, ctx(), item.id, new Date(Date.now() + 60_000));
    const woken = await withTenant(app.db, { tenantId: NORTHWIND }, (tx) =>
      wakeDueItems(tx, new Date(Date.now() + 120_000)),
    );
    expect(woken).toBeGreaterThanOrEqual(1);
    expect(await get(item.id)).toMatchObject({ status: 'open' });
    const [audit] = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, item.id), eq(auditEvents.actor, 'automation:work.wake')));
    expect(audit).toBeDefined();
  });

  it('cannot touch another tenant’s item', async () => {
    const item = await newItem();
    const other = { tenantId: '01a00000-0000-7000-8000-000000000002', userId };
    expect(await resolveItem(app.db, other, item.id, { reason: 'Duplicate item' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('assigns to a teammate with a notification, and unassigns back to open (W-05)', async () => {
    const item = await newItem();
    const [marcus] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'marcus@northwind.test'));
    expect(await assignItem(app.db, ctx(), item.id, marcus!.id)).toEqual({ ok: true });
    expect(await get(item.id)).toMatchObject({ status: 'assigned', assigneeId: marcus!.id });
    const [note] = await admin.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, marcus!.id), eq(notifications.entityId, item.id)));
    expect(note!.summary).toBe('Assigned to you: Claim review');
    expect(await assignItem(app.db, ctx(), item.id, null)).toEqual({ ok: true });
    expect(await get(item.id)).toMatchObject({ status: 'open', assigneeId: null });
  });

  it('S-03: hands back what a deactivated person had, or what is outside the clients they keep', async () => {
    const [dana] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'dana@northwind.test'));
    const a = await newItem('claim_review', CLIENTS[0]!.id);
    const b = await newItem('claim_review', CLIENTS[1]!.id);
    const c = await newItem('claim_review', CLIENTS[1]!.id);
    for (const i of [a, b, c]) await assignItem(app.db, ctx(), i.id, dana!.id);
    await admin.db.update(workItems).set({ status: 'in_progress' }).where(eq(workItems.id, c.id));
    expect(await unassignItemsOf(app.db, ctx(), dana!.id, 'all')).toBe(0);
    expect(await unassignItemsOf(app.db, ctx(), dana!.id, [CLIENTS[0]!.id])).toBe(2);
    expect(await get(a.id)).toMatchObject({ status: 'assigned', assigneeId: dana!.id });
    expect(await get(b.id)).toMatchObject({ status: 'open', assigneeId: null });
    expect(await get(c.id)).toMatchObject({ status: 'open', assigneeId: null });
    expect(await unassignItemsOf(app.db, ctx(), dana!.id, 'none')).toBeGreaterThanOrEqual(1);
    expect(await get(a.id)).toMatchObject({ status: 'open', assigneeId: null });
  });

  it('W-22: never snoozes a timely-filing item past its filing limit', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const c = await admin.db.execute<{ id: string }>(sql`
      with p as (
        insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
        values (${NORTHWIND}, ${CLIENTS[0]!.id}, 'Ana', 'Quillon', '1984-03-07', 'F') returning id),
      e as (
        insert into encounters (tenant_id, client_id, patient_id, date_of_service, rendering_provider_id, location_id)
        select ${NORTHWIND}, ${CLIENTS[0]!.id}, p.id, ${day(-80)}::date,
          (select id from providers where client_id = ${CLIENTS[0]!.id} limit 1),
          (select id from locations where client_id = ${CLIENTS[0]!.id} limit 1)
        from p returning id, patient_id)
      insert into claims (tenant_id, client_id, patient_id, encounter_id, mode, total_charge_cents, status, filing_deadline)
      select ${NORTHWIND}, ${CLIENTS[0]!.id}, e.patient_id, e.id, 'A', 14500, 'needs_review', ${day(2)}::date from e
      returning id`);
    const item = await newItem('timely_filing_risk');
    await admin.db.update(workItems).set({ claimId: c.rows[0]!.id }).where(eq(workItems.id, item.id));
    expect(await snoozeItem(app.db, ctx(), item.id, new Date(Date.now() + 5 * 86_400_000))).toEqual({
      ok: false,
      reason: 'past_deadline',
      latest: day(2),
    });
    expect(await snoozeItem(app.db, ctx(), item.id, new Date(Date.now() + 86_400_000))).toEqual({ ok: true });
  });

  it('W-22: escalating assigns to the admin with an urgent notification that links to the item', async () => {
    const item = await newItem('timely_filing_risk');
    const [priya] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'priya@northwind.test'));
    expect(await assignItem(app.db, ctx(), item.id, priya!.id, { escalated: true })).toEqual({ ok: true });
    const [note] = await admin.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, priya!.id), eq(notifications.entityId, item.id)));
    expect(note).toMatchObject({
      summary: 'Escalated to you: Timely filing',
      urgent: true,
      link: `/work?item=${item.id}`,
      type: 'work_item.escalated',
    });
    const audit = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'work_item.escalated'), eq(auditEvents.entityId, item.id)));
    expect(audit).toHaveLength(1);
  });
});
