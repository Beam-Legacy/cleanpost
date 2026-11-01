/**
 * M1 acceptance: seeded PM data lands in the canonical tables with correct external refs, a repeat
 * pull creates no duplicates, and clients that share a PM account share its rate limit.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryRateLimiter, type Connection } from '@cleanpost/adapters';
import {
  auditEvents,
  chargeLines,
  connections,
  coverages,
  decryptField,
  diagnoses,
  encounters,
  externalRefs,
  patients,
  syncRuns,
} from '@cleanpost/db';
import { addVisits, pmSchema } from '@cleanpost/pm-mock';
import { scanForPhi } from '@cleanpost/testing';
import { createPgRateLimiter, listCandidates, planTick, runSync } from '../src';
import { admin, app, closeAll, connectionOf, deps, pm, seedWorld } from './helpers';

const NORTHWIND = '01a00000-0000-7000-8000-000000000001';

async function pmCounts(practiceId: string) {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  return {
    patients: await n(
      pm.db
        .select({ n: count() })
        .from(pmSchema.patients)
        .where(eq(pmSchema.patients.practiceId, practiceId)),
    ),
    policies: await n(
      pm.db
        .select({ n: count() })
        .from(pmSchema.policies)
        .where(eq(pmSchema.policies.practiceId, practiceId)),
    ),
    encounters: await n(
      pm.db
        .select({ n: count() })
        .from(pmSchema.encounters)
        .where(eq(pmSchema.encounters.practiceId, practiceId)),
    ),
    charges: await n(
      pm.db
        .select({ n: count() })
        .from(pmSchema.charges)
        .innerJoin(pmSchema.encounters, eq(pmSchema.encounters.id, pmSchema.charges.encounterId))
        .where(eq(pmSchema.encounters.practiceId, practiceId)),
    ),
  };
}

async function cleanpostCounts(clientId: string) {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  return {
    patients: await n(admin.db.select({ n: count() }).from(patients).where(eq(patients.clientId, clientId))),
    coverages: await n(
      admin.db.select({ n: count() }).from(coverages).where(eq(coverages.clientId, clientId)),
    ),
    encounters: await n(
      admin.db.select({ n: count() }).from(encounters).where(eq(encounters.clientId, clientId)),
    ),
    lines: await n(
      admin.db.select({ n: count() }).from(chargeLines).where(eq(chargeLines.clientId, clientId)),
    ),
    diagnoses: await n(
      admin.db.select({ n: count() }).from(diagnoses).where(eq(diagnoses.clientId, clientId)),
    ),
  };
}

beforeAll(async () => {
  await seedWorld();
});

afterAll(async () => {
  await closeAll();
});

describe('first sync', () => {
  it('loads patients, coverage, encounters, lines and diagnoses with external refs', async () => {
    const conn = await connectionOf('Lakeside');
    expect(conn.status).toBe('testing');
    const res = await runSync(deps(), { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'schedule' });
    expect(res).toMatchObject({ status: 'done', connectionStatus: 'healthy' });

    const source = await pmCounts('lakeside');
    const stored = await cleanpostCounts(conn.clientId);
    expect(stored.patients).toBe(source.patients);
    expect(stored.coverages).toBe(source.policies);
    expect(stored.encounters).toBe(source.encounters);
    expect(stored.lines).toBe(source.charges);
    expect(stored.diagnoses).toBeGreaterThanOrEqual(stored.encounters);

    const refs = await admin.db
      .select({ type: externalRefs.entityType, n: count() })
      .from(externalRefs)
      .where(eq(externalRefs.connectionId, conn.id))
      .groupBy(externalRefs.entityType);
    expect(Object.fromEntries(refs.map((r) => [r.type, r.n]))).toMatchObject({
      patient: source.patients,
      coverage: source.policies,
      encounter: source.encounters,
    });
  });

  it('maps each record to the right PM record, provider and location', async () => {
    const conn = await connectionOf('Lakeside');
    const [ref] = await admin.db
      .select()
      .from(externalRefs)
      .where(and(eq(externalRefs.connectionId, conn.id), eq(externalRefs.entityType, 'encounter')))
      .limit(1);
    const [enc] = await admin.db.select().from(encounters).where(eq(encounters.id, ref!.entityId));
    const [pmEnc] = await pm.db
      .select()
      .from(pmSchema.encounters)
      .where(eq(pmSchema.encounters.id, ref!.externalId));
    expect(enc!.dateOfService).toBe(pmEnc!.dateOfService);
    expect(enc!.pmStatus).toBe(pmEnc!.workflowStatus);
    expect(enc!.externalIds).toEqual({ [conn.id]: pmEnc!.id });
    expect(enc!.renderingProviderId).not.toBeNull();
    expect(enc!.locationId).not.toBeNull();
    const lines = await admin.db.select().from(chargeLines).where(eq(chargeLines.encounterId, enc!.id));
    const pmLines = await pm.db
      .select()
      .from(pmSchema.charges)
      .where(eq(pmSchema.charges.encounterId, pmEnc!.id));
    expect(lines.map((l) => [l.code, l.chargeCents]).sort()).toEqual(
      pmLines.map((l) => [l.code, l.chargeCents]).sort(),
    );
  });

  it('stores member IDs encrypted, with the last four for display', async () => {
    const conn = await connectionOf('Lakeside');
    const [cov] = await admin.db
      .select()
      .from(coverages)
      .where(eq(coverages.clientId, conn.clientId))
      .limit(1);
    expect(cov!.memberIdEncrypted.startsWith('v1:')).toBe(true);
    const plain = decryptField(cov!.memberIdEncrypted);
    expect(plain).toMatch(/^XQ\d{8}$/);
    expect(cov!.memberIdLast4).toBe(plain.slice(-4));
    expect(cov!.payerId).not.toBeNull();
  });

  it('audit-logs every record it created, as automation', async () => {
    const conn = await connectionOf('Lakeside');
    const rows = await admin.db
      .select({ action: auditEvents.action, actor: auditEvents.actor, n: count() })
      .from(auditEvents)
      .where(eq(auditEvents.clientId, conn.clientId))
      .groupBy(auditEvents.action, auditEvents.actor);
    const by = Object.fromEntries(rows.map((r) => [`${r.action}|${r.actor}`, r.n]));
    const source = await pmCounts('lakeside');
    expect(by['patient.created|automation:sync.pull']).toBe(source.patients);
    expect(by['encounter.created|automation:sync.pull']).toBe(source.encounters);
    expect(by['connection.status_changed|automation:sync.pull']).toBe(1);
    const metadata = await admin.db
      .select({ m: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.clientId, conn.clientId));
    expect(scanForPhi(JSON.stringify(metadata))).toEqual([]);
  });

  it('records one succeeded sync run per operation with counts', async () => {
    const conn = await connectionOf('Lakeside');
    const runs = await admin.db.select().from(syncRuns).where(eq(syncRuns.connectionId, conn.id));
    expect(runs.map((r) => [r.operation, r.status]).sort()).toEqual([
      ['pullCharges', 'succeeded'],
      ['pullPatientsAndCoverage', 'succeeded'],
    ]);
    const source = await pmCounts('lakeside');
    expect(runs.find((r) => r.operation === 'pullCharges')!.counts).toMatchObject({
      new: source.encounters,
      failed: 0,
    });
  });
});

describe('repeat sync', () => {
  it('creates no duplicates and reports everything unchanged', async () => {
    const conn = await connectionOf('Lakeside');
    const before = await cleanpostCounts(conn.clientId);
    // Run as a manual sync: the schedule would wait for next_run_at.
    const res = await runSync(deps(), { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' });
    expect(res.status).toBe('done');
    if (res.status === 'done') {
      for (const op of res.operations) expect(op.counts).toMatchObject({ new: 0, changed: 0, failed: 0 });
    }
    expect(await cleanpostCounts(conn.clientId)).toEqual(before);
  });

  it('picks up new visits and changed records', async () => {
    const conn = await connectionOf('Lakeside');
    const ids = await addVisits(pm.db, { practiceId: 'lakeside', count: 3, now: new Date() });
    const [pt] = await pm.db
      .select()
      .from(pmSchema.patients)
      .where(eq(pmSchema.patients.practiceId, 'lakeside'))
      .limit(1);
    await pm.db
      .update(pmSchema.patients)
      .set({ phone: '503-555-0199', updatedAt: new Date() })
      .where(eq(pmSchema.patients.id, pt!.id));
    const res = await runSync(deps(), { tenantId: NORTHWIND, connectionId: conn.id, trigger: 'manual' });
    if (res.status !== 'done') throw new Error('sync skipped');
    const byOp = Object.fromEntries(res.operations.map((o) => [o.operation, o.counts]));
    expect(byOp.pullCharges).toMatchObject({ new: 3 });
    expect(byOp.pullPatientsAndCoverage).toMatchObject({ changed: 1, new: 0 });
    const refs = await admin.db
      .select({ n: count() })
      .from(externalRefs)
      .where(and(eq(externalRefs.connectionId, conn.id), sql`${externalRefs.externalId} in ${ids}`));
    expect(refs[0]!.n).toBe(3);
  });
});

describe('PM account rate limits', () => {
  const conn = (id: string, pmAccountRef: string | null): Connection => ({
    id,
    tenantId: NORTHWIND,
    clientId: '01a00000-0000-7000-8000-0000000000c1',
    adapterKey: 'mock',
    credentialsSecretRef: null,
    pmAccountRef,
    settings: {},
  });

  it('makes connections in one PM account wait for each other, across limiter instances', async () => {
    // Two limiters stand for two worker processes; the bucket lives in Postgres.
    const one = createPgRateLimiter(app.db);
    const two = createPgRateLimiter(app.db);
    const a = conn('01a00000-0000-7000-8000-00000000aa01', 'tebra:shared-test');
    const b = conn('01a00000-0000-7000-8000-00000000aa02', 'tebra:shared-test');
    const started = Date.now();
    await one.acquire(a, 'GetCharges-test', 1);
    await two.acquire(b, 'GetCharges-test', 1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(850);
  });

  it('does not slow down connections in different accounts', async () => {
    const limiter = createPgRateLimiter(app.db);
    const started = Date.now();
    await limiter.acquire(conn('01a00000-0000-7000-8000-00000000aa03', 'acct-1'), 'GetCharges-test', 1);
    await limiter.acquire(conn('01a00000-0000-7000-8000-00000000aa04', 'acct-2'), 'GetCharges-test', 1);
    expect(Date.now() - started).toBeLessThan(800);
  });

  it('refuses to wait longer than allowed, with a retryable error', async () => {
    const limiter = createPgRateLimiter(app.db);
    const c = conn('01a00000-0000-7000-8000-00000000aa05', 'acct-3');
    await limiter.acquire(c, 'slow-endpoint', 0.1);
    await expect(limiter.acquire(c, 'slow-endpoint', 0.1, 100)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });

  it('syncs Lakeside and Willamette at once under Tebra’s real limits without being refused', async () => {
    const strict = deps({ rateScale: 1 });
    const lakeside = await connectionOf('Lakeside');
    const willamette = await connectionOf('Willamette');
    const [x, y] = await Promise.all([
      runSync(strict, { tenantId: NORTHWIND, connectionId: lakeside.id, trigger: 'manual' }),
      runSync(strict, { tenantId: NORTHWIND, connectionId: willamette.id, trigger: 'manual' }),
    ]);
    for (const r of [x, y]) {
      expect(r).toMatchObject({ status: 'done', connectionStatus: 'healthy' });
      if (r.status === 'done') expect(r.operations.every((o) => o.ok)).toBe(true);
    }
    // The memory limiter is per process; only the Postgres one is shared.
    expect(createMemoryRateLimiter).toBeTypeOf('function');
  });
});

describe('schedule', () => {
  it('lists connections across tenants and plans the due ones', async () => {
    const candidates = await listCandidates(app.db);
    const lakeside = await connectionOf('Lakeside');
    const willamette = await connectionOf('Willamette');
    const ids = candidates.map((c) => c.connectionId);
    expect(ids).toEqual(expect.arrayContaining([lakeside.id, willamette.id]));
    // Manual and file connections are not on a schedule; the onboarding stub is still in setup.
    const plan = planTick(candidates, new Date());
    expect(plan.due.map((c) => c.connectionId)).not.toContain(lakeside.id);
    const later = planTick(candidates, new Date(Date.now() + 121 * 60_000));
    expect(later.due.map((c) => c.connectionId)).toContain(lakeside.id);
    const muchLater = planTick(candidates, new Date(Date.now() + 5 * 60 * 60_000));
    expect(muchLater.stale.map((c) => c.connectionId)).toContain(lakeside.id);
  });

  it('runs on the connection’s own interval (Tebra profile: 2 hours)', async () => {
    const [row] = await admin.db
      .select({ next: connections.nextRunAt, last: connections.lastSuccessAt })
      .from(connections)
      .where(eq(connections.id, (await connectionOf('Lakeside')).id));
    expect(row!.next!.getTime() - row!.last!.getTime()).toBeGreaterThanOrEqual(119 * 60_000);
  });
});
