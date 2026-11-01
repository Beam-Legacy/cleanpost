/**
 * The mock adapter (packages/adapters) against a running pm-mock: the adapter contract suite for each
 * profile, plus how PM faults and rate limits reach Cleanpost. Part of `pnpm test:adapters`.
 */
import {
  createDevSecretResolver,
  createMemoryRateLimiter,
  createMockAdapter,
  PROFILES,
  type Connection,
  type RateLimiter,
} from '@cleanpost/adapters';
import { adapterContract } from '@cleanpost/adapters/testing';
import { scanForPhi } from '@cleanpost/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encounters } from '../src/schema';
import { handle, SECRET, seedTestWorld, testApp } from './helpers';

const app = testApp();
const since = new Date('2020-01-01T00:00:00Z');

/** fetch over the in-process app, honouring abort signals the way a real fetch does. */
function appFetch(target = app, headers: Record<string, string> = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason));
      const h = new Headers(init?.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      Promise.resolve(target.request(String(input), { ...init, headers: h })).then(resolve, reject);
    })) as typeof fetch;
}

const secrets = createDevSecretResolver({ pmMockSecret: SECRET });

function adapter(opts: { headers?: Record<string, string>; limiter?: RateLimiter; timeoutMs?: number } = {}) {
  return createMockAdapter({
    baseUrl: 'http://pm-mock.test',
    secrets,
    limiter: opts.limiter ?? createMemoryRateLimiter(),
    fetch: appFetch(app, opts.headers),
    pageSize: 9,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

function connection(practiceId: string, account: string, pmAccountRef: string | null, n: number): Connection {
  return {
    id: `01a00000-0000-7000-8000-0000000c0${String(n).padStart(3, '0')}`,
    tenantId: '01a00000-0000-7000-8000-000000000001',
    clientId: '01a00000-0000-7000-8000-0000000000c1',
    adapterKey: 'mock',
    credentialsSecretRef: `pm-mock:${account}`,
    pmAccountRef,
    settings: { practiceId },
  };
}

const lakeside = connection('lakeside', 'northwind-billing', 'tebra:northwind-billing', 1);
const willamette = connection('willamette', 'northwind-billing', 'tebra:northwind-billing', 2);
const cascade = connection('cascade', 'cascade-pediatrics', null, 3);
const generic = connection('generic', 'generic-account', null, 4);

async function encounterIn(practiceId: string, status: { workflowStatus?: string; status?: string }) {
  const [row] = await handle.db
    .select({ id: encounters.id })
    .from(encounters)
    .where(
      and(
        eq(encounters.practiceId, practiceId),
        status.workflowStatus
          ? eq(encounters.workflowStatus, status.workflowStatus)
          : eq(encounters.status, status.status ?? 'ready'),
      ),
    )
    .limit(1);
  return row!.id;
}

beforeAll(async () => {
  await seedTestWorld();
});

afterAll(async () => {
  await handle.close();
});

const shared = adapter();
adapterContract('mock (tebra profile)', async () => ({
  adapter: shared,
  conn: lakeside,
  since,
  sampleEncounterId: await encounterIn('lakeside', { workflowStatus: 'Review' }),
}));
adapterContract('mock (managed API profile)', async () => ({
  adapter: shared,
  conn: cascade,
  since,
  sampleEncounterId: await encounterIn('cascade', { status: 'ready' }),
}));
adapterContract('mock (generic profile)', async () => ({
  adapter: shared,
  conn: generic,
  since,
  sampleEncounterId: await encounterIn('generic', { status: 'ready' }),
}));

describe('mock adapter', () => {
  it('reports the capabilities of the practice’s profile', async () => {
    expect(await shared.capabilities(lakeside)).toEqual(PROFILES.tebra);
    expect(await shared.capabilities(cascade)).toEqual(PROFILES.managed_api);
    expect(await shared.capabilities(generic)).toEqual(PROFILES.generic);
  });

  it('maps Tebra’s workflow onto contract statuses and keeps the PM status', async () => {
    const page = await shared.pullCharges(lakeside, since);
    for (const e of page.items) {
      expect(['Draft', 'Review', 'Approved', 'Rejected']).toContain(e.pmClaimStatus);
      expect(e.status).toBe(
        { Draft: 'open', Review: 'ready', Approved: 'billed', Rejected: 'open' }[e.pmClaimStatus!],
      );
    }
  });

  it('holds and releases through Tebra’s encounter review', async () => {
    const id = await encounterIn('willamette', { workflowStatus: 'Review' });
    expect(await shared.holdCharge(willamette, id)).toEqual({ ok: true });
    expect(await shared.releaseCharge(willamette, id)).toEqual({ ok: true });
    const [row] = await handle.db.select().from(encounters).where(eq(encounters.id, id));
    expect(row!.workflowStatus).toBe('Approved');
    const again = await shared.holdCharge(willamette, id);
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT', retryable: false });
  });

  it('turns Tebra’s missing write operations into manual tasks with Tebra’s screens', async () => {
    const res = await shared.postPayment(lakeside, {
      remittanceId: '01a00000-0000-7000-8000-00000000c0de',
      traceNumber: 'EFT-M-1',
      paymentDate: '2026-10-21',
      paymentAmountCents: 100,
      allocations: [],
    });
    expect(res).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
      manualTask: { title: 'Post the payment in Tebra' },
    });
  });

  it('posts payments for the generic profile and returns the PM payment ID', async () => {
    const id = await encounterIn('generic', { status: 'ready' });
    const [line] =
      (await shared.pullCharges(generic, since)).items.find((e) => e.externalId === id)?.lines ?? [];
    const res = await shared.postPayment(generic, {
      remittanceId: '01a00000-0000-7000-8000-00000000c0df',
      traceNumber: 'EFT-M-2',
      paymentDate: '2026-10-21',
      paymentAmountCents: 5_000,
      allocations: line
        ? [
            {
              encounterExternalId: id,
              lineExternalId: line.externalId,
              paidCents: 5_000,
              adjustments: [{ pmAdjustmentCode: 'CONTR', amountCents: 1_000 }],
              patientRespCents: 0,
              transferToSecondary: false,
            },
          ]
        : [],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalRef).toMatch(/^PAY-/);
  });
});

describe('PM faults reach Cleanpost as typed errors', () => {
  const cases: [string, string, boolean][] = [
    ['auth_expired', 'AUTH_FAILED', false],
    ['error_500', 'UPSTREAM_ERROR', true],
    ['rate_limited', 'RATE_LIMITED', true],
    ['partial_page', 'UPSTREAM_ERROR', true],
  ];
  for (const [fault, code, retryable] of cases) {
    it(`${fault} -> ${code}`, async () => {
      // Capabilities are cached first without the fault, so the fault hits the pull itself.
      const a = adapter({ headers: {} });
      await a.capabilities(lakeside);
      const faulty = createMockAdapter({
        baseUrl: 'http://pm-mock.test',
        secrets,
        limiter: createMemoryRateLimiter(),
        fetch: appFetch(app, { 'x-mock-fault': fault }),
      });
      const err = await faulty.pullPatientsAndCoverage(lakeside, since).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'AdapterError', code, retryable });
      expect(scanForPhi(String((err as Error).message))).toEqual([]);
    });
  }

  it('times out a PM that does not answer', async () => {
    const slow = adapter({ headers: { 'x-mock-fault': 'latency:2000' }, timeoutMs: 200 });
    const err = await slow.pullPatientsAndCoverage(lakeside, since).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TIMEOUT', retryable: true });
  });

  it('fails with AUTH_FAILED when no credentials are saved', async () => {
    const err = await shared
      .pullCharges(
        { ...generic, id: '01a00000-0000-7000-8000-0000000c0999', credentialsSecretRef: null },
        since,
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
  });
});

describe('rate limits', () => {
  it('shares one limit between connections in the same PM account and stays under the PM’s limit', async () => {
    const strict = testApp({ rateScale: 1 });
    const limiter = createMemoryRateLimiter();
    const a = createMockAdapter({
      baseUrl: 'http://pm-mock.test',
      secrets,
      limiter,
      fetch: appFetch(strict),
    });
    const started = Date.now();
    // GetCharges is one call per second per Tebra account. Two practices in one account: the second
    // waits for the first instead of being refused by the PM.
    const [x, y] = await Promise.all([a.pullCharges(lakeside, since), a.pullCharges(willamette, since)]);
    expect(x.items.length + y.items.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('does not slow down connections in different accounts', async () => {
    const strict = testApp({ rateScale: 1 });
    const a = createMockAdapter({
      baseUrl: 'http://pm-mock.test',
      secrets,
      limiter: createMemoryRateLimiter(),
      fetch: appFetch(strict),
    });
    await a.capabilities(lakeside);
    await a.capabilities(cascade);
    await new Promise((r) => setTimeout(r, 1_100));
    const started = Date.now();
    await Promise.all([a.pullCharges(lakeside, since), a.pullCharges(cascade, since)]);
    expect(Date.now() - started).toBeLessThan(900);
  });
});
