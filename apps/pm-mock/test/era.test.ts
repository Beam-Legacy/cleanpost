/**
 * The clearinghouse loop against payer-sim (docs/12-testing.md): queued claims go out, 277CAs come
 * back, and after the payer's adjudication delay the 835s land in the PM's ERA inbox and are
 * auto-posted, with the deliberate posting faults of src/era.ts.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remit } from '@cleanpost/domain';
import { createPayerSimApp, createSimDb } from '@cleanpost/payer-sim';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { parse835 } from '@cleanpost/x12';
import { linePosting, postingFault, runClearinghouse, loadRoster } from '../src';
import { claims, encounters, payments, postings, remittances } from '../src/schema';
import { bearer, handle, log, seedTestWorld, testApp } from './helpers';

const simDb = createSimDb(testDatabaseUrls().adminUrl, 2);
const sim = createPayerSimApp({ db: simDb.db, log });
const simFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(sim.request(String(input).replace('http://payer-sim.test', ''), init))) as typeof fetch;
const ch = { db: handle.db, log, payerSimUrl: 'http://payer-sim.test', fetch: simFetch };
const advance = (q: string) => sim.request(`/clock/advance?${q}`, { method: 'POST' });

let pcns: string[] = [];

beforeAll(async () => {
  await seedTestWorld();
  await loadRoster(handle.db, { payerSimUrl: 'http://payer-sim.test', fetch: simFetch });
  // Queue 25 of the generic practice's encounters as the PM would on release.
  const rows = await handle.db
    .select({ id: encounters.id })
    .from(encounters)
    .leftJoin(claims, eq(claims.encounterId, encounters.id))
    .where(and(eq(encounters.practiceId, 'generic'), isNull(claims.encounterId)))
    .limit(25);
  pcns = rows.map((r) => r.id);
  await handle.db.insert(claims).values(
    rows.map((r) => ({
      encounterId: r.id,
      practiceId: 'generic',
      patientControlNumber: r.id,
      status: 'queued',
      updatedAt: new Date(),
    })),
  );
});

afterAll(async () => {
  await simDb.close();
  await handle.close();
});

describe('clearinghouse and ERAs', () => {
  it('sends claims, reads 277CAs, then brings in balanced 835s and auto-posts them', async () => {
    expect(pcns.length).toBeGreaterThan(5);
    expect((await runClearinghouse(ch)).sent).toBeGreaterThanOrEqual(pcns.length);
    await advance('minutes=31');
    const acked = await runClearinghouse(ch);
    expect(acked.remits).toBe(0);
    const statuses = async () =>
      handle.db
        .select({ status: claims.status })
        .from(claims)
        .where(inArray(claims.patientControlNumber, pcns));
    const accepted = (await statuses()).filter((c) => c.status === 'accepted').length;
    expect(accepted + (await statuses()).filter((c) => c.status === 'rejected').length).toBe(pcns.length);
    expect(accepted).toBeGreaterThan(0);

    await advance('days=21');
    const paid = await runClearinghouse(ch);
    expect(paid.remits).toBeGreaterThan(0);
    expect(paid.linesPosted).toBeGreaterThan(0);

    const eras = await handle.db.select().from(remittances).where(eq(remittances.practiceId, 'generic'));
    // The run covers every practice; other test files may have queued claims elsewhere.
    expect(eras.length).toBeGreaterThan(0);
    expect(eras.length).toBeLessThanOrEqual(paid.remits);
    for (const e of eras) {
      const r = parse835((e.payload as { raw835: string }).raw835);
      expect(remit.balance835(r).balanced).toBe(true);
    }
    const decided = (await statuses()).filter((c) => c.status === 'paid' || c.status === 'denied');
    expect(decided.length).toBe(accepted);

    const pays = await handle.db
      .select()
      .from(payments)
      .where(and(eq(payments.practiceId, 'generic'), eq(payments.source, 'clearinghouse')));
    expect(pays.length).toBe(eras.length);
    const lines = await handle.db
      .select()
      .from(postings)
      .where(
        inArray(
          postings.paymentId,
          pays.map((p) => p.id),
        ),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(paid.linesPosted);

    // A second run is a no-op: nothing is posted twice.
    expect((await runClearinghouse(ch)).remits).toBe(0);
  });

  it('offers the ERA through the PM API with the original file', async () => {
    const app = testApp();
    const res = await app.request('/api/v1/practices/generic/remittances?since=2020-01-01T00:00:00Z', {
      headers: bearer('generic-account'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { era: { raw835: string; claims: unknown[] } }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]!.era.raw835).toMatch(/^ISA\*/);
  });
});

describe('auto-posting', () => {
  const line: remit.ServiceLinePayment = {
    code: '99213',
    modifiers: [],
    chargeCents: 13_500,
    paidCents: 7_500,
    units: 1,
    allowedCents: 10_000,
    lineControlNumber: 'C1',
    serviceDate: '2026-10-01',
    adjustments: [
      { group: 'CO', carc: '45', amountCents: 3_500 },
      { group: 'PR', carc: '3', amountCents: 2_500 },
    ],
    remarks: [],
  };

  it('posts in the PM codes and transfers patient responsibility', () => {
    expect(linePosting(line, null)).toEqual({
      paidCents: 7_500,
      adjustments: [
        { code: 'CONTR', amountCents: 3_500 },
        { code: 'COPAY', amountCents: 2_500 },
      ],
      patientRespCents: 2_500,
    });
  });

  it('gets a few lines wrong, the way auto-posting does', () => {
    expect(linePosting(line, 'skipped')).toBeNull();
    expect(linePosting(line, 'wrong_code')!.adjustments[0]).toEqual({ code: 'WO', amountCents: 3_500 });
    const denied = {
      ...line,
      paidCents: 0,
      adjustments: [{ group: 'CO' as const, carc: '197', amountCents: 13_500 }],
    };
    expect(linePosting(denied, null)!.adjustments).toEqual([]);
    expect(linePosting(denied, 'denial_written_off')!.adjustments).toEqual([
      { code: 'CONTR', amountCents: 13_500 },
    ]);
    const faults = Array.from({ length: 2000 }, (_, i) => postingFault(`k${i}`, false)).filter(
      Boolean,
    ).length;
    expect(faults).toBeGreaterThan(20);
    expect(faults).toBeLessThan(120);
  });
});
