import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, createDatabase, users, withTenant, workItems } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND } from '@cleanpost/seed/world';
import { reopenItem, resolveItem, snoozeItem, wakeDueItems, wakeItem } from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
let userId = '';
const ctx = () => ({ tenantId: NORTHWIND, userId });

async function newItem(type = 'claim_review') {
  const [row] = await admin.db
    .insert(workItems)
    .values({
      tenantId: NORTHWIND,
      clientId: CLIENTS[0]!.id,
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
});
