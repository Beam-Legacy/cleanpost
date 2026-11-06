/**
 * The worker over a real job queue: the tick queues due connections, sync.pull runs them, Run now
 * queues at most one job per connection, and a job that ran out of retries becomes a system work
 * item. Connects as the app role, like production.
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claims,
  connections,
  createDatabase,
  eligibilityChecks,
  scrubResults,
  syncRuns,
  workItems,
  auditEvents,
  usageRecords,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createBoss, JOBS, sendSyncPull } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { createStediEligibilityClient } from '@cleanpost/eligibility';
import { createPayerSimApp, createSimDb } from '@cleanpost/payer-sim';
import { createPmDb, createPmMockApp, loadRoster } from '@cleanpost/pm-mock';
import { seedPmMock } from '@cleanpost/pm-mock/seed';
import { seed } from '@cleanpost/seed';
import { CLIENTS } from '@cleanpost/seed/world';
import {
  buildRegistry,
  handleDeadLetter,
  handleSyncPull,
  handleTick,
  registerWorkers,
  type WorkerDeps,
  handleUsageMeter,
} from '../src/handlers';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
const SECRET = 'pm-mock-worker-test-secret-01';
const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 8 });
const pm = createPmDb(urls.adminUrl, 3);
const log = createLogger({ name: 'worker-test' });
const boss = createBoss(urls.url, 'worker');
const pmApp = createPmMockApp({ db: pm.db, log, rateScale: 1000 });
const pmFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(pmApp.request(String(input), init))) as typeof fetch;

const simDb = createSimDb(urls.adminUrl, 2);
const simApp = createPayerSimApp({ db: simDb.db, log });
const simFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(simApp.request(String(input).replace('http://payer-sim.test', ''), init))) as typeof fetch;

const deps: WorkerDeps = {
  db: app.db,
  boss,
  log,
  retryDelaysMs: [20],
  // Eligibility against payer-sim, as in local and preview: build -> eligibility.check -> scrub.
  eligibility: createStediEligibilityClient({
    apiKey: 'payer-sim',
    baseUrl: 'http://payer-sim.test',
    kind: 'payer-sim',
    fetch: simFetch,
  }),
  registry: buildRegistry({
    db: app.db,
    pmMock: { url: 'http://pm-mock.test', secret: SECRET, fetch: pmFetch },
  }),
};

const mockClients = CLIENTS.filter((c) => c.pmMock);

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function statusOf(clientId: string) {
  const [row] = await admin.db.select().from(connections).where(eq(connections.clientId, clientId));
  return row!;
}

beforeAll(async () => {
  await seed(admin.db, 'worker-test-password-123');
  await seedPmMock(pm.db, { secret: SECRET, asOf: new Date(), scale: 0.1 });
  await loadRoster(pm.db, { payerSimUrl: 'http://payer-sim.test', fetch: simFetch });
  await boss.start();
  await registerWorkers(deps, { schedule: false, concurrency: 3 });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await Promise.all([admin.close(), app.close(), pm.close(), simDb.close()]);
});

describe('schedule', () => {
  it('queues every due mock-PM connection and the workers make them healthy', async () => {
    const res = await handleTick(deps);
    expect(res.queued).toBe(mockClients.length);
    for (const c of mockClients) {
      await waitFor(async () => (await statusOf(c.id)).status === 'healthy');
    }
  });

  it('turns synced charges into scrubbed claims: sync.pull -> claim.build -> claim.scrub', async () => {
    const ids = mockClients.map((c) => c.id);
    await waitFor(async () => {
      const rows = await admin.db
        .select({ status: claims.status })
        .from(claims)
        .where(inArray(claims.clientId, ids));
      return rows.length > 0 && rows.every((r) => ['ready', 'needs_review', 'blocked'].includes(r.status));
    }, 60_000);
    const results = await admin.db.select({ n: count() }).from(scrubResults);
    expect(results[0]!.n).toBeGreaterThan(0);
    // Coverage was checked with the payer before the scrub (step 2), so the scrub read the result.
    const checks = await admin.db.select({ status: eligibilityChecks.status }).from(eligibilityChecks);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.status === 'active')).toBe(true);
    const findings = await admin.db.select({ f: scrubResults.findings }).from(scrubResults);
    const notChecked = findings.filter((r) =>
      ((r.f as { items: { ruleId: string }[] }).items ?? []).some(
        (i) => i.ruleId === 'eligibility.not_checked',
      ),
    );
    expect(notChecked.length).toBeLessThan(findings.length);
  });

  it('queues nothing until the next run is due', async () => {
    expect(await handleTick(deps)).toMatchObject({ due: 0, queued: 0 });
  });
});

describe('Run now', () => {
  it('queues at most one job per connection', async () => {
    const lakeside = await statusOf(mockClients[0]!.id);
    await boss.offWork(JOBS.syncPull);
    const payload = { tenantId: NORTHWIND, connectionId: lakeside.id, trigger: 'manual' as const };
    expect(await sendSyncPull(boss, payload)).toBeTypeOf('string');
    expect(await sendSyncPull(boss, payload)).toBeNull();
    const before = (await admin.db.select().from(syncRuns).where(eq(syncRuns.connectionId, lakeside.id)))
      .length;
    await boss.work(JOBS.syncPull, { batchSize: 1 }, async ([job]) => {
      if (job) await handleSyncPull(deps, job.data);
    });
    await waitFor(async () => {
      const runs = await admin.db.select().from(syncRuns).where(eq(syncRuns.connectionId, lakeside.id));
      return runs.length >= before + 2 && runs.every((r) => r.status !== 'running');
    });
  });

  it('refuses a payload that is not IDs only', async () => {
    await expect(
      handleSyncPull(deps, { tenantId: NORTHWIND, connectionId: 'not-a-uuid', trigger: 'manual' }),
    ).rejects.toThrow();
    await expect(
      sendSyncPull(boss, { tenantId: NORTHWIND, connectionId: 'x', trigger: 'manual' } as never),
    ).rejects.toThrow();
  });
});

describe('dead letters', () => {
  it('turns a job that ran out of retries into a system work item', async () => {
    const lakeside = await statusOf(mockClients[0]!.id);
    await handleDeadLetter(deps, { tenantId: NORTHWIND, connectionId: lakeside.id, trigger: 'schedule' });
    const items = await admin.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.connectionId, lakeside.id), eq(workItems.type, 'system')));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ priority: 1, reasonCode: 'JOB_FAILED', status: 'open' });
  });
});

describe('usage.meter', () => {
  it('meters every company, backfilling one with no records, and runs again without doubling', async () => {
    const first = await handleUsageMeter(deps, {});
    expect(first.days).toBe(7);
    const metered = await admin.db
      .select({ n: count() })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'usage.metered'));
    // The first run backfills 120 days for each company with no records.
    expect(metered[0]!.n).toBeGreaterThanOrEqual(120);
    const before = await admin.db.select().from(usageRecords);
    await handleUsageMeter(deps, {});
    const after = await admin.db.select().from(usageRecords);
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.claimsReleased).sort()).toEqual(before.map((r) => r.claimsReleased).sort());
  });
});
