import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, encounters, patients, writeLog } from '../src/schema';
import { resetPmMockForHistory } from '../src/seed';
import { adminAuth, bearer, handle, seedTestWorld, testApp } from './helpers';

const app = testApp();
const SINCE = '2020-01-01T00:00:00Z';
type Json = Record<string, unknown> & { items: Record<string, unknown>[]; nextCursor: string | null };

async function get(path: string, account: string, headers: Record<string, string> = {}) {
  return app.request(`/api/v1${path}`, { headers: { ...bearer(account), ...headers } });
}

async function post(path: string, account: string, body: unknown = {}) {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { ...bearer(account), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function pullAll(path: string, account: string, limit = 7) {
  const items: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const res = await get(
      `${path}?since=${SINCE}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      account,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    items.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return items;
}

beforeAll(async () => {
  await seedTestWorld();
});

afterAll(async () => {
  await handle.close();
});

describe('authentication', () => {
  it('requires a key and only serves practices in the key’s account', async () => {
    expect((await app.request('/api/v1/practices/lakeside')).status).toBe(401);
    const wrong = await app.request('/api/v1/practices/lakeside', {
      headers: { authorization: 'Bearer not-a-key' },
    });
    expect(wrong.status).toBe(401);
    expect((await get('/practices/lakeside', 'cascade-pediatrics')).status).toBe(404);
    const ok = await get('/practices/lakeside', 'northwind-billing');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 'lakeside', profile: 'tebra' });
  });
});

describe('pulls', () => {
  it('pages patients from since to the end, without duplicates, the same way twice', async () => {
    const first = await pullAll('/practices/lakeside/patients', 'northwind-billing');
    expect(first.length).toBe(27);
    expect(new Set(first.map((p) => p.id)).size).toBe(first.length);
    expect((first[0]!.policies as unknown[]).length).toBeGreaterThan(0);
    const second = await pullAll('/practices/lakeside/patients', 'northwind-billing', 11);
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
  });

  it('filters by since', async () => {
    const all = await pullAll('/practices/lakeside/encounters', 'northwind-billing');
    const cut = all[Math.floor(all.length / 2)]!.updatedAt as string;
    const res = await get(`/practices/lakeside/encounters?since=${cut}&limit=200`, 'northwind-billing');
    const body = (await res.json()) as Json;
    expect(body.items.every((e) => (e.updatedAt as string) >= cut)).toBe(true);
    expect(body.items.length).toBeLessThan(all.length);
  });

  it('shows Tebra workflow status for Tebra practices and status with hold flag otherwise', async () => {
    const tebra = await pullAll('/practices/lakeside/encounters', 'northwind-billing');
    expect(new Set(tebra.map((e) => e.workflowStatus))).toEqual(
      new Set(
        ['Draft', 'Review', 'Approved', 'Rejected'].filter((s) => tebra.some((e) => e.workflowStatus === s)),
      ),
    );
    expect(tebra.every((e) => e.status === undefined)).toBe(true);
    const generic = await pullAll('/practices/generic/encounters', 'generic-account');
    expect(generic.every((e) => typeof e.status === 'string' && typeof e.onHold === 'boolean')).toBe(true);
    const line = (generic[0]!.charges as Record<string, unknown>[])[0]!;
    expect(Number.isInteger(line.amountCents)).toBe(true);
    expect(line).not.toHaveProperty('description');
  });

  it('has no remittance files for Tebra', async () => {
    const res = await get(`/practices/lakeside/remittances?since=${SINCE}`, 'northwind-billing');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_available' });
    expect((await get(`/practices/generic/remittances?since=${SINCE}`, 'generic-account')).status).toBe(200);
  });

  it('serves claim status for billed encounters, and queues the ones approved since', async () => {
    const claimRows = await pullAll('/practices/lakeside/claims', 'northwind-billing');
    expect(claimRows.length).toBeGreaterThan(0);
    // Loaded billed encounters were accepted; encounters approved by other tests wait in the batch.
    expect(claimRows.every((c) => c.status === 'accepted' || c.status === 'queued')).toBe(true);
    expect(claimRows.some((c) => c.status === 'accepted')).toBe(true);
  });

  it('rejects a bad query or cursor without echoing it', async () => {
    const res = await get('/practices/lakeside/patients?limit=5', 'northwind-billing');
    expect(res.status).toBe(400);
    const bad = await get(`/practices/lakeside/patients?since=${SINCE}&cursor=zzz`, 'northwind-billing');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).not.toContain('zzz');
  });
});

describe('Tebra encounter workflow', () => {
  it('holds while in review and releases by approving', async () => {
    const all = await pullAll('/practices/lakeside/encounters', 'northwind-billing');
    const review = all.find((e) => e.workflowStatus === 'Review')!;
    const hold = await post(
      `/practices/lakeside/encounters/${review.id as string}/hold`,
      'northwind-billing',
    );
    expect(await hold.json()).toMatchObject({ ok: true, workflowStatus: 'Review' });
    const release = await post(
      `/practices/lakeside/encounters/${review.id as string}/release`,
      'northwind-billing',
    );
    expect(await release.json()).toMatchObject({ ok: true, workflowStatus: 'Approved' });
    const again = await post(
      `/practices/lakeside/encounters/${review.id as string}/hold`,
      'northwind-billing',
    );
    expect(again.status).toBe(409);
  });

  it('cannot approve a draft, mark billed or take corrections', async () => {
    const all = await pullAll('/practices/lakeside/encounters', 'northwind-billing');
    const draft = all.find((e) => e.workflowStatus === 'Draft');
    if (draft) {
      expect(
        (await post(`/practices/lakeside/encounters/${draft.id as string}/release`, 'northwind-billing'))
          .status,
      ).toBe(409);
    }
    const any = all[0]!.id as string;
    const billed = await post(`/practices/lakeside/encounters/${any}/billed`, 'northwind-billing', {
      patientControlNumber: 'PCN1',
    });
    expect(billed.status).toBe(404);
    const corr = await post(`/practices/lakeside/encounters/${any}/corrections`, 'northwind-billing', {
      changes: [{ lineNumber: 1, field: 'modifiers', value: ['25'] }],
    });
    expect(await corr.json()).toMatchObject({ error: 'not_available' });
  });

  it('creates payment headers only', async () => {
    const res = await post('/practices/lakeside/payments', 'northwind-billing', {
      traceNumber: 'EFT-T-1',
      paymentDate: '2026-10-21',
      amountCents: 12_345,
      lines: [{ encounterId: 'x', chargeId: 'y', paidCents: 1, adjustments: [], patientRespCents: 0 }],
    });
    expect(await res.json()).toMatchObject({ ok: true, headerOnly: true });
    const postingsPage = await pullAll('/practices/lakeside/postings', 'northwind-billing');
    expect(postingsPage).toEqual([]);
  });
});

describe('generic profile writes', () => {
  it('holds, corrects, marks billed and posts payments', async () => {
    const all = await pullAll('/practices/generic/encounters', 'generic-account');
    const target = all.find((e) => e.status === 'ready' || e.status === 'open')!;
    const id = target.id as string;
    expect(
      await (await post(`/practices/generic/encounters/${id}/hold`, 'generic-account')).json(),
    ).toMatchObject({ onHold: true });
    const corr = await post(`/practices/generic/encounters/${id}/corrections`, 'generic-account', {
      changes: [{ lineNumber: 1, field: 'modifiers', value: ['25'] }],
    });
    expect(corr.status).toBe(200);
    const billed = await post(`/practices/generic/encounters/${id}/billed`, 'generic-account', {
      patientControlNumber: 'CP-0001',
    });
    expect(billed.status).toBe(200);
    const after = (await pullAll('/practices/generic/encounters', 'generic-account')).find(
      (e) => e.id === id,
    )!;
    expect(after).toMatchObject({ status: 'billed', onHold: false, patientControlNumber: 'CP-0001' });
    expect((after.charges as { modifiers: string[] }[])[0]!.modifiers).toEqual(['25']);

    const line = (after.charges as { id: string }[])[0]!;
    const pay = {
      traceNumber: 'EFT-G-1',
      paymentDate: '2026-10-21',
      amountCents: 9_000,
      lines: [
        {
          encounterId: id,
          chargeId: line.id,
          paidCents: 9_000,
          adjustments: [{ code: 'CONTR', amountCents: 4_500 }],
          patientRespCents: 0,
        },
      ],
    };
    const first = (await (await post('/practices/generic/payments', 'generic-account', pay)).json()) as {
      id: string;
    };
    const repeat = await (await post('/practices/generic/payments', 'generic-account', pay)).json();
    expect(repeat).toMatchObject({ id: first.id, existing: true });
    const posted = await pullAll('/practices/generic/postings', 'generic-account');
    // Only this payment's lines: the clearinghouse tests post ERAs to the same practice.
    expect(posted.filter((p) => p.traceNumber === 'EFT-G-1')).toEqual([
      expect.objectContaining({ traceNumber: 'EFT-G-1', encounterId: id, paidCents: 9_000 }),
    ]);
    const logged = await handle.db.select().from(writeLog).where(eq(writeLog.practiceId, 'generic'));
    expect(logged.map((w) => w.operation)).toEqual(
      expect.arrayContaining(['hold', 'correct', 'mark_billed', 'post_payment']),
    );
  });

  it('refuses payment lines for charges in another practice', async () => {
    const res = await post('/practices/generic/payments', 'generic-account', {
      traceNumber: 'EFT-G-2',
      paymentDate: '2026-10-21',
      amountCents: 1,
      lines: [
        {
          encounterId: 'LFM-E10001',
          chargeId: 'LFM-E10001-1',
          paidCents: 1,
          adjustments: [],
          patientRespCents: 0,
        },
      ],
    });
    expect(res.status).toBe(422);
  });
});

describe('faults', () => {
  it('injects faults from the request header', async () => {
    const path = `/practices/lakeside/patients?since=${SINCE}`;
    const auth = await get(path, 'northwind-billing', { 'x-mock-fault': 'auth_expired' });
    expect(auth.status).toBe(401);
    expect(await auth.json()).toMatchObject({ error: 'token_expired' });
    expect((await get(path, 'northwind-billing', { 'x-mock-fault': 'error_500' })).status).toBe(500);
    const limited = await get(path, 'northwind-billing', { 'x-mock-fault': 'rate_limited' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    const partial = await get(path, 'northwind-billing', { 'x-mock-fault': 'partial_page' });
    expect(partial.status).toBe(200);
    await expect(partial.json()).rejects.toThrow();
  });

  it('applies account faults for a number of requests, then clears them', async () => {
    const res = await app.request('/admin/api/accounts/northwind-billing/faults', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'error_500', count: 2, endpoint: 'GetCharges' }),
    });
    expect(res.status).toBe(200);
    const path = `/practices/willamette/encounters?since=${SINCE}`;
    // Other endpoints are unaffected.
    expect((await get(`/practices/willamette/patients?since=${SINCE}`, 'northwind-billing')).status).toBe(
      200,
    );
    expect((await get(path, 'northwind-billing')).status).toBe(500);
    expect((await get(path, 'northwind-billing')).status).toBe(500);
    expect((await get(path, 'northwind-billing')).status).toBe(200);
    const [account] = await handle.db.select().from(accounts).where(eq(accounts.id, 'northwind-billing'));
    expect(account!.faults).toEqual([]);
  });

  it('breaks and clears the login behind a practice (the demo)', async () => {
    const res = await app.request('/admin/api/practices/lakeside/faults', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'auth_expired' }),
    });
    expect(await res.json()).toEqual({ ok: true, accountId: 'northwind-billing' });
    const path = `/practices/lakeside/patients?since=${SINCE}`;
    expect((await get(path, 'northwind-billing')).status).toBe(401);
    expect((await get(path, 'northwind-billing')).status).toBe(401);
    const cleared = await app.request('/admin/api/practices/lakeside/faults', {
      method: 'DELETE',
      headers: adminAuth,
    });
    expect(cleared.status).toBe(200);
    expect((await get(path, 'northwind-billing')).status).toBe(200);
    expect(
      (await app.request('/admin/api/practices/nowhere/faults', { method: 'DELETE', headers: adminAuth }))
        .status,
    ).toBe(404);
  });
});

describe('rate limits', () => {
  it('enforces Tebra’s per-account limits across the account’s practices', async () => {
    const slow = testApp({ rateScale: 1 });
    const call = (pid: string) =>
      slow.request(`/api/v1/practices/${pid}/encounters?since=${SINCE}&limit=1`, {
        headers: bearer('northwind-billing'),
      });
    // GetCharges allows one call per second per account (docs/15-integrations-reference.md).
    expect((await call('lakeside')).status).toBe(200);
    const second = await call('willamette');
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: 'rate_limited',
      message: 'Rate limit exceeded for GetCharges',
    });
    // A different endpoint has its own bucket.
    const patientsRes = await slow.request(`/api/v1/practices/willamette/patients?since=${SINCE}&limit=1`, {
      headers: bearer('northwind-billing'),
    });
    expect(patientsRes.status).toBe(200);
    // Another account is unaffected.
    const other = await slow.request(`/api/v1/practices/cascade/encounters?since=${SINCE}&limit=1`, {
      headers: bearer('cascade-pediatrics'),
    });
    expect(other.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await call('willamette')).status).toBe(200);
  });
});

describe('admin', () => {
  it('requires the admin password and refuses cross-site form posts', async () => {
    expect((await app.request('/admin')).status).toBe(401);
    const page = await app.request('/admin', { headers: adminAuth });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Lakeside Family Medicine');
    const cross = await app.request('/admin/accounts/northwind-billing/faults/clear', {
      method: 'POST',
      headers: { ...adminAuth, 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
  });

  it('adds today’s visits for existing patients with new encounter numbers', async () => {
    const before = await handle.db
      .select({ id: encounters.id })
      .from(encounters)
      .where(eq(encounters.practiceId, 'willamette'));
    const res = await app.request('/admin/api/practices/willamette/visits', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 4 }),
    });
    const body = (await res.json()) as { encounters: string[] };
    expect(body.encounters).toHaveLength(4);
    expect(body.encounters.every((id) => /^WOR-E\d+$/.test(id))).toBe(true);
    expect(body.encounters.some((id) => before.some((b) => b.id === id))).toBe(false);
    const fresh = await handle.db
      .select({ w: encounters.workflowStatus })
      .from(encounters)
      .where(
        sql`${encounters.id} in (${sql.join(
          body.encounters.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    expect(fresh.every((f) => f.w === 'Draft' || f.w === 'Review')).toBe(true);
  });

  it('adds visits on an earlier date, all finished when no share is left open (demo history)', async () => {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await app.request('/admin/api/practices/willamette/visits', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ count: 6, dateOfService: day, openShare: 0 }),
    });
    const body = (await res.json()) as { encounters: string[] };
    const rows = await handle.db
      .select({ dos: encounters.dateOfService, w: encounters.workflowStatus })
      .from(encounters)
      .where(
        sql`${encounters.id} in (${sql.join(
          body.encounters.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.dos === day && r.w === 'Review')).toBe(true);
    const tooOld = await app.request('/admin/api/practices/willamette/visits', {
      method: 'POST',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ dateOfService: '2020-01-01' }),
    });
    expect(tooOld.status).toBe(422);
  });

  it('starts over for demo history: patients and coverage as of the date, no visits', async () => {
    const asOf = new Date(Date.now() - 90 * 86_400_000);
    const out = await resetPmMockForHistory(handle.db, { asOf, scale: 0.15 });
    expect(out.map((p) => p.practiceId).sort()).toEqual(['cascade', 'lakeside', 'willamette']);
    const [{ n } = { n: -1 }] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(encounters);
    expect(n).toBe(0);
    const pts = await handle.db.select({ id: patients.id }).from(patients);
    expect(pts.length).toBe(out.reduce((s, p) => s + p.patients, 0));
    // The world loads again on top (the other suites seed in their own setup).
    await seedTestWorld();
  });
});
