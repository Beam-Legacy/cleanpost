/**
 * M1 acceptance: fault injection (auth expiry, 500s, partial pages, rate limits) leads to the right
 * connection states and work items. Runs against Cascade Pediatrics (its own mock PM account).
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connections, syncRuns, users, workItems } from '@cleanpost/db';
import { pmSchema } from '@cleanpost/pm-mock';
import { scanForPhi } from '@cleanpost/testing';
import { runSync, setPaused, markStale, type Candidate } from '../src';
import { admin, closeAll, connectionOf, deps, pm, seedWorld } from './helpers';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const JULIA_EMAIL = 'julia@northwind.test';
type Fault = pmSchema.AccountFault;

async function setFaults(faults: Fault[]) {
  await pm.db.update(pmSchema.accounts).set({ faults }).where(eq(pmSchema.accounts.id, 'cascade-pediatrics'));
}

async function cascade() {
  return connectionOf('Cascade');
}

async function sync(trigger: 'schedule' | 'manual' = 'manual') {
  return runSync(deps(), { tenantId: NORTHWIND, connectionId: (await cascade()).id, trigger });
}

async function openItems() {
  const c = await cascade();
  return admin.db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.connectionId, c.id),
        eq(workItems.type, 'sync_failure'),
        ne(workItems.status, 'resolved'),
      ),
    );
}

async function lastRun(operation: string) {
  const c = await cascade();
  const [row] = await admin.db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, c.id), eq(syncRuns.operation, operation)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row!;
}

beforeAll(async () => {
  await seedWorld();
  await setFaults([]);
  const res = await sync('schedule');
  expect(res).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
});

beforeEach(async () => {
  await setFaults([]);
});

afterAll(async () => {
  await setFaults([]);
  await closeAll();
});

describe('transient faults', () => {
  it('retries a couple of 500s and stays healthy', async () => {
    await setFaults([{ kind: 'error_500', remaining: 2, endpoints: ['encounters'] }]);
    const res = await sync();
    expect(res).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
    expect((await lastRun('pullCharges')).status).toBe('succeeded');
  });

  it('retries a partial page and stays healthy', async () => {
    await setFaults([{ kind: 'partial_page', remaining: 1, endpoints: ['patients'] }]);
    expect(await sync()).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
  });

  it('waits out a rate-limit response and stays healthy', async () => {
    await setFaults([{ kind: 'rate_limited', remaining: 1, endpoints: ['encounters'] }]);
    expect(await sync()).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
  });
});

describe('persistent faults', () => {
  it('degrades when one operation keeps failing, with one sync_failure work item', async () => {
    await setFaults([{ kind: 'error_500', endpoints: ['encounters'] }]);
    const res = await sync();
    expect(res).toMatchObject({ status: 'done', connectionStatus: 'degraded' });
    const run = await lastRun('pullCharges');
    expect(run).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM_ERROR' });
    expect((await lastRun('pullPatientsAndCoverage')).status).toBe('succeeded');
    const items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ priority: 1, reasonCode: 'UPSTREAM_ERROR' });
    expect(items[0]!.summary).toContain('Cascade Pediatrics: AdvancedMD connection is degraded.');
  });

  it('degrades on persistent partial pages too, without a second work item', async () => {
    await setFaults([{ kind: 'partial_page', endpoints: ['patients'] }]);
    expect(await sync()).toMatchObject({ connectionStatus: 'degraded' });
    expect((await lastRun('pullPatientsAndCoverage')).errorDetail).toBe('The PM sent an incomplete response');
    expect(await openItems()).toHaveLength(1);
  });

  it('fails after three cycles in a row in which everything failed', async () => {
    await setFaults([{ kind: 'error_500' }]);
    expect(await sync()).toMatchObject({ connectionStatus: 'degraded' });
    expect(await sync()).toMatchObject({ connectionStatus: 'degraded' });
    expect(await sync()).toMatchObject({ connectionStatus: 'failed' });
    const [row] = await admin.db
      .select()
      .from(connections)
      .where(eq(connections.id, (await cascade()).id));
    expect(row!.consecutiveFailedCycles).toBe(3);
    const items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain('connection failed');
  });

  it('stops scheduled syncs on a failed connection; a manual run that works recovers it', async () => {
    expect(await sync('schedule')).toEqual({ status: 'skipped', reason: 'failed' });
    await setFaults([]);
    expect(await sync('manual')).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
    expect(await openItems()).toEqual([]);
    const [resolved] = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.connectionId, (await cascade()).id), eq(workItems.type, 'sync_failure')))
      .orderBy(desc(workItems.createdAt))
      .limit(1);
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedBy: 'automation:sync.pull',
      resolution: 'Connection recovered',
    });
  });
});

describe('authentication', () => {
  it('fails at once when the PM rejects the credentials and skips the remaining pulls', async () => {
    await setFaults([{ kind: 'auth_expired' }]);
    const res = await sync();
    expect(res).toMatchObject({ status: 'done', connectionStatus: 'failed' });
    if (res.status === 'done') {
      expect(res.operations).toHaveLength(1);
      expect(res.operations[0]).toMatchObject({ ok: false, authFailed: true, errorCode: 'AUTH_FAILED' });
    }
    const items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.reasonCode).toBe('AUTH_FAILED');
    expect(items[0]!.summary).toContain('The PM rejected the saved credentials');
    await setFaults([]);
    expect(await sync()).toMatchObject({ connectionStatus: 'healthy' });
  });
});

describe('records the PM sends in a shape Cleanpost cannot read', () => {
  it('counts them as failed with the PM record ID and field, and keeps going', async () => {
    const [enc] = await pm.db
      .select()
      .from(pmSchema.encounters)
      .where(eq(pmSchema.encounters.practiceId, 'cascade'))
      .limit(1);
    await pm.db
      .update(pmSchema.encounters)
      .set({ renderingNpi: '12345', updatedAt: new Date() })
      .where(eq(pmSchema.encounters.id, enc!.id));
    const res = await sync();
    expect(res).toMatchObject({ connectionStatus: 'healthy' });
    const run = await lastRun('pullCharges');
    expect(run.status).toBe('succeeded');
    expect(run.counts).toMatchObject({ failed: 1 });
    expect(run.errorDetail).toBe(`1 record could not be read: ${enc!.id} (renderingProviderNpi)`);
  });
});

describe('pause, resume and staleness', () => {
  it('pauses and resumes through the state machine', async () => {
    const c = await cascade();
    const [julia] = await admin.db.select({ id: users.id }).from(users).where(eq(users.email, JULIA_EMAIL));
    const userId = julia!.id;
    expect(await setPaused(deps().db, { tenantId: NORTHWIND, userId }, c.id, true)).toEqual({
      ok: true,
      status: 'paused',
    });
    expect(await sync('manual')).toEqual({ status: 'skipped', reason: 'paused' });
    expect(await setPaused(deps().db, { tenantId: NORTHWIND, userId }, c.id, false)).toEqual({
      ok: true,
      status: 'testing',
    });
    expect(await sync('schedule')).toMatchObject({ connectionStatus: 'healthy' });
  });

  it('marks a healthy connection degraded when it has not synced for twice its schedule', async () => {
    const c = await cascade();
    const candidate: Candidate = {
      tenantId: NORTHWIND,
      connectionId: c.id,
      adapterKey: 'mock',
      status: 'healthy',
      syncIntervalMinutes: null,
      lastSuccessAt: c.lastSuccessAt,
      nextRunAt: c.nextRunAt,
    };
    await markStale(deps().db, candidate, new Date());
    const [row] = await admin.db.select().from(connections).where(eq(connections.id, c.id));
    expect(row!.status).toBe('degraded');
    expect((await openItems())[0]!.reasonCode).toBe('STALE');
    expect(await sync()).toMatchObject({ connectionStatus: 'healthy' });
  });
});

describe('no PHI in what sync writes about failures', () => {
  it('keeps run details and work item summaries free of patient data', async () => {
    const c = await cascade();
    const runs = await admin.db.select().from(syncRuns).where(eq(syncRuns.connectionId, c.id));
    const items = await admin.db.select().from(workItems).where(eq(workItems.connectionId, c.id));
    expect(scanForPhi(JSON.stringify({ runs, items }))).toEqual([]);
  });
});
