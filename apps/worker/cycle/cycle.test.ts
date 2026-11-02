/**
 * `pnpm test:cycle` (docs/12-testing.md "Cycle test"), Mode A: Northwind's mock-PM clients run the
 * whole loop on the real job queue, with pm-mock and payer-sim in process and the payer's clock
 * moved 45 days:
 *   sync -> build -> eligibility -> scrub -> a biller approves what is in review -> release in the
 *   PM (Tebra: approve the encounter; no-hold PM: its own billing batch) -> clearinghouse -> 277CA
 *   -> adjudication -> 835 -> the PM auto-posts -> Cleanpost reads the 835 (PM API) or a person
 *   uploads it (Tebra) -> posting match.
 * Then it checks what the MVP calls working: every claim ends in a terminal or expected state, the
 * scrub catches at least 95% of seeded defects, every 835 balances, every 835 line is verified or
 * has exactly one open work item, no patient data in logs or job payloads, no cross-tenant reads.
 */
import { readFileSync } from 'node:fs';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveClaim } from '@cleanpost/claims';
import {
  claims,
  connections,
  createDatabase,
  externalRefs,
  pmPostings,
  remitClaims,
  remitLines,
  remittances,
  users,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createStediEligibilityClient } from '@cleanpost/eligibility';
import { createBoss, sendClaimRelease, sendSyncPull } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { createPayerSimApp, createSimDb } from '@cleanpost/payer-sim';
import { createPmDb, createPmMockApp, loadRoster, pmSchema, runClearinghouse } from '@cleanpost/pm-mock';
import { seedPmMock } from '@cleanpost/pm-mock/seed';
import { ingestRemittance, verifyInTx } from '@cleanpost/remit';
import { seed } from '@cleanpost/seed';
import { CLIENTS, HARBOR_RCM, NORTHWIND } from '@cleanpost/seed/world';
import { scanForPhi } from '@cleanpost/testing';
import { parse835 } from '@cleanpost/x12';
import { buildRegistry, registerWorkers, type WorkerDeps } from '../src/handlers';

const SECRET = 'pm-mock-cycle-test-secret-01';
/** About 500 encounters across the three mock-PM practices (docs/12: 500). */
const SCALE = 0.6;
/** Days the payer's clock moves at each step: 45 in all. */
const STEPS = [1, 4, 7, 7, 7, 7, 12];

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 3 });
const app = createDatabase(urls.url, { max: 8 });
const pm = createPmDb(urls.adminUrl, 3);
const log = createLogger({ name: 'cycle-test' });
const boss = createBoss(urls.url, 'worker');
const pmApp = createPmMockApp({ db: pm.db, log, rateScale: 1000 });
const pmFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(pmApp.request(String(input), init))) as typeof fetch;
const simDb = createSimDb(urls.adminUrl, 2);
const simApp = createPayerSimApp({ db: simDb.db, log });
const simFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(simApp.request(String(input).replace('http://payer-sim.test', ''), init))) as typeof fetch;
const clearinghouse = { db: pm.db, log, payerSimUrl: 'http://payer-sim.test', fetch: simFetch };

const deps: WorkerDeps = {
  db: app.db,
  boss,
  log,
  retryDelaysMs: [20],
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

const mockClients = CLIENTS.filter((c) => c.tenantId === NORTHWIND && c.pmMock);
const clientIds = mockClients.map((c) => c.id);
const clientOfPractice = new Map(mockClients.map((c) => [c.pmMock!.practiceId, c]));

/** Waits until no job is waiting, running or retrying (future-dated releases are not due yet). */
async function quiet(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (let calm = 0; calm < 3;) {
    const [row] = (
      await admin.db.execute<{ n: number }>(sql`
        select count(*)::int as n from pgboss.job
        where state in ('created', 'retry', 'active') and start_after <= now()`)
    ).rows;
    calm = row!.n === 0 ? calm + 1 : 0;
    if (Date.now() > deadline) throw new Error('the job queue did not go quiet');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function syncAll() {
  const conns = await admin.db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.clientId, clientIds));
  for (const c of conns)
    await sendSyncPull(boss, { tenantId: NORTHWIND, connectionId: c.id, trigger: 'manual' });
  await quiet();
}

const advance = (days: number) => simApp.request(`/clock/advance?days=${days}`, { method: 'POST' });

let biller = '';
const uploaded = new Set<string>();
/** Tebra has no ERA API: a person downloads each 835 from the PM and uploads it (R-02). */
async function uploadTebraEras() {
  const eras = await pm.db.select().from(pmSchema.remittances);
  for (const e of eras) {
    const client = clientOfPractice.get(e.practiceId);
    if (!client || client.profile !== 'tebra' || uploaded.has(e.id)) continue;
    uploaded.add(e.id);
    const raw = (e.payload as { raw835: string }).raw835;
    const ctx = { tenantId: NORTHWIND, clientId: client.id };
    await ingestRemittance(
      { db: app.db, log },
      { ...ctx, source: 'file', actor: `user:${biller}` },
      parse835(raw),
    );
    await withTenant(app.db, { tenantId: NORTHWIND }, (tx) => verifyInTx(tx, ctx, new Date()));
  }
}

const caught = { defective: 0, blocked: 0, clean: 0, falseBlocks: 0 };

beforeAll(async () => {
  await seed(admin.db, 'cycle-test-password-123');
  await seedPmMock(pm.db, { secret: SECRET, asOf: new Date(), scale: SCALE });
  await loadRoster(pm.db, { payerSimUrl: 'http://payer-sim.test', fetch: simFetch });
  const [u] = await admin.db.select().from(users).where(eq(users.email, 'marcus@northwind.test'));
  biller = u!.id;
  await boss.start();
  await registerWorkers(deps, { schedule: false, concurrency: 4 });

  // 1. Charges in: sync, build, eligibility, scrub.
  await syncAll();

  // The scrub, before anyone touches a claim: seeded defects should be blocked, clean claims not.
  // Seeded defects: the encounter's own (codes, modifiers, pointers, duplicates, auth) and its
  // primary coverage's (inactive at the payer, or really another payer's member).
  const key = await pm.db
    .select({ id: pmSchema.answerKey.recordId })
    .from(pmSchema.answerKey)
    .where(eq(pmSchema.answerKey.recordType, 'encounter'));
  const badCoverage = await pm.db
    .select({ encounterId: pmSchema.encounters.id })
    .from(pmSchema.encounters)
    .innerJoin(
      pmSchema.policies,
      and(eq(pmSchema.policies.patientId, pmSchema.encounters.patientId), eq(pmSchema.policies.priority, 1)),
    )
    .innerJoin(
      pmSchema.answerKey,
      and(
        eq(pmSchema.answerKey.recordType, 'coverage'),
        eq(pmSchema.answerKey.recordId, pmSchema.policies.id),
      ),
    )
    .where(
      sql`(${pmSchema.answerKey.facts}->>'inactive')::boolean is true or ${pmSchema.answerKey.facts} ? 'actualPayerName'`,
    );
  const defective = new Set([...key.map((k) => k.id), ...badCoverage.map((b) => b.encounterId)]);
  const scrubbed = await admin.db
    .select({ status: claims.status, externalId: externalRefs.externalId })
    .from(claims)
    .innerJoin(
      externalRefs,
      and(eq(externalRefs.entityId, claims.encounterId), eq(externalRefs.entityType, 'encounter')),
    )
    .where(inArray(claims.clientId, clientIds));
  for (const r of scrubbed) {
    if (defective.has(r.externalId)) {
      caught.defective++;
      if (r.status === 'blocked') caught.blocked++;
    } else {
      caught.clean++;
      if (r.status === 'blocked') caught.falseBlocks++;
    }
  }

  // 2. A biller approves what is in review; blocked claims wait for a fix.
  const review = await admin.db
    .select({ id: claims.id })
    .from(claims)
    .where(and(inArray(claims.clientId, clientIds), eq(claims.status, 'needs_review')));
  for (const c of review) {
    const res = await approveClaim(app.db, { tenantId: NORTHWIND, userId: biller, claimId: c.id });
    if (res.ok) await sendClaimRelease(boss, { tenantId: NORTHWIND, claimId: c.id, userId: biller });
  }
  await quiet();

  // 3. 45 days at the payer: claims out at each step, acknowledgments and 835s back.
  for (const days of STEPS) {
    await runClearinghouse(clearinghouse, { bill: true });
    await advance(days);
    await runClearinghouse(clearinghouse);
    await uploadTebraEras();
    await syncAll();
  }
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await Promise.all([admin.close(), app.close(), pm.close(), simDb.close()]);
});

describe('the Mode A cycle', () => {
  it('ran on enough claims to mean something', async () => {
    const rows = await admin.db
      .select({ n: sql<number>`count(*)::int` })
      .from(claims)
      .where(inArray(claims.clientId, clientIds));
    expect(rows[0]!.n).toBeGreaterThan(50);
    expect(uploaded.size).toBeGreaterThan(0);
  });

  it('scrub catches at least 95% of seeded defects with at most 5% false blocks', () => {
    expect(caught.defective).toBeGreaterThan(0);
    expect(caught.blocked / caught.defective).toBeGreaterThanOrEqual(0.95);
    expect(caught.falseBlocks / caught.clean).toBeLessThanOrEqual(0.05);
  });

  it('brings every claim to a terminal or expected state, with an open item where a person is needed', async () => {
    const rows = await admin.db
      .select({ id: claims.id, status: claims.status })
      .from(claims)
      .where(inArray(claims.clientId, clientIds));
    const open = await admin.db
      .select({ claimId: workItems.claimId, type: workItems.type })
      .from(workItems)
      .where(and(isNotNull(workItems.claimId), ne(workItems.status, 'resolved')));
    const has = (id: string, type: string) => open.some((o) => o.claimId === id && o.type === type);
    const NEEDS_ITEM: Record<string, string> = {
      blocked: 'claim_blocked',
      rejected: 'rejection',
      denied: 'denial',
    };
    const TERMINAL = new Set(['paid', 'partially_paid', 'closed', 'voided']);
    const wrong = rows.filter(
      (r) => !TERMINAL.has(r.status) && !(NEEDS_ITEM[r.status] && has(r.id, NEEDS_ITEM[r.status]!)),
    );
    const byStatus = wrong.reduce<Record<string, number>>(
      (m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }),
      {},
    );
    expect(byStatus).toEqual({});
    expect(rows.filter((r) => r.status === 'paid' || r.status === 'partially_paid').length).toBeGreaterThan(
      0,
    );
  });

  it('balances every 835', async () => {
    const rows = await admin.db
      .select({ status: remittances.status })
      .from(remittances)
      .where(inArray(remittances.clientId, clientIds));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.status === 'out_of_balance')).toEqual([]);
  });

  it('leaves every 835 line verified or with exactly one open work item, and no item without a cause', async () => {
    const lines = await admin.db
      .select({ line: remitLines, rc: remitClaims })
      .from(remitLines)
      .innerJoin(remitClaims, eq(remitClaims.id, remitLines.remitClaimId))
      .where(inArray(remitClaims.clientId, clientIds));
    const items = await admin.db
      .select()
      .from(workItems)
      .where(
        and(
          inArray(workItems.clientId, clientIds),
          inArray(workItems.type, ['posting_exception', 'mapping_needed', 'remit_unmatched']),
          ne(workItems.status, 'resolved'),
        ),
      );
    const problems: string[] = [];
    for (const { line, rc } of lines) {
      if (!rc.claimId) continue; // unmatched payments: checked below
      if (line.verifyStatus === 'verified') continue;
      if (line.verifyStatus === 'mismatch' || line.verifyStatus === 'missing') {
        const covering = items.filter(
          (i) =>
            i.type === 'posting_exception' &&
            i.remittanceId === rc.remittanceId &&
            (i.claimId === rc.claimId || i.claimId === null),
        );
        if (covering.length !== 1) problems.push(`${line.verifyStatus} line with ${covering.length} items`);
      } else if (line.verifyStatus === 'unmapped') {
        if (!items.some((i) => i.type === 'mapping_needed' && i.clientId === rc.clientId))
          problems.push('unmapped line with no mapping item');
      } else problems.push(`line still ${line.verifyStatus ?? 'unchecked'}`);
    }
    for (const i of items.filter((x) => x.type === 'posting_exception')) {
      const bad = lines.filter(
        ({ line, rc }) =>
          rc.remittanceId === i.remittanceId &&
          (i.claimId === null || rc.claimId === i.claimId) &&
          (line.verifyStatus === 'mismatch' || line.verifyStatus === 'missing'),
      );
      if (!bad.length) problems.push('posting item with no differing line');
    }
    const byRemit = new Map<string, number>();
    const unmatchedClaims = await admin.db
      .select({ remittanceId: remitClaims.remittanceId })
      .from(remitClaims)
      .where(and(inArray(remitClaims.clientId, clientIds), eq(remitClaims.matchStatus, 'unmatched')));
    for (const u of unmatchedClaims) byRemit.set(u.remittanceId, (byRemit.get(u.remittanceId) ?? 0) + 1);
    for (const [remittanceId, n] of byRemit) {
      const k = items.filter((i) => i.type === 'remit_unmatched' && i.remittanceId === remittanceId).length;
      if (k !== n) problems.push(`${n} unmatched payments with ${k} items`);
    }
    expect(problems).toEqual([]);
    expect(lines.filter(({ line }) => line.verifyStatus === 'verified').length).toBeGreaterThan(0);
  });

  it('read back what the PM posted', async () => {
    const rows = await admin.db
      .select({ n: sql<number>`count(*)::int` })
      .from(pmPostings)
      .where(inArray(pmPostings.clientId, clientIds));
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('kept patient data out of logs and job payloads', async () => {
    const logs = readFileSync(process.env.CLEANPOST_LOG_FILE!, 'utf8');
    expect(logs.length).toBeGreaterThan(0);
    expect(scanForPhi(logs)).toEqual([]);
    const jobs = (
      await admin.db.execute<{ data: string }>(sql`select coalesce(data::text, '') as data from pgboss.job`)
    ).rows;
    expect(jobs.length).toBeGreaterThan(0);
    expect(scanForPhi(jobs.map((j) => j.data).join('\n'))).toEqual([]);
  });

  it('never let another tenant read this data', async () => {
    const seen = await withTenant(app.db, { tenantId: HARBOR_RCM }, async (tx) => ({
      claims: (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(claims)
          .where(eq(claims.tenantId, NORTHWIND))
      )[0]!.n,
      remittances: (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(remittances)
          .where(eq(remittances.tenantId, NORTHWIND))
      )[0]!.n,
      postings: (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(pmPostings)
          .where(eq(pmPostings.tenantId, NORTHWIND))
      )[0]!.n,
      items: (
        await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(workItems)
          .where(eq(workItems.tenantId, NORTHWIND))
      )[0]!.n,
    }));
    expect(seen).toEqual({ claims: 0, remittances: 0, postings: 0, items: 0 });
  });
});
