/**
 * Mock adapter (docs/05-adapters.md): talks to apps/pm-mock over HTTP, like a real adapter talks to
 * a PM. The practice's profile on the mock PM (generic, tebra, managed_api) sets the capabilities,
 * so the whole cycle runs against a PM as limited as Tebra. Template for real adapters: credentials
 * by reference, the shared rate limiter before every call, typed errors, Zod at the boundary.
 *
 * Connection settings: { practiceId } and optionally { baseUrl }.
 */
import type {
  CapabilityMap,
  ChargeCorrection,
  Connection,
  OpResult,
  Operation,
  Page,
  PmAdapter,
  PostingInstruction,
} from '../contract';
import type { RateLimiter, SecretResolver } from '../deps';
import type { FileSource } from '../file';
import { PROFILES } from '../profiles';
import { AdapterError, failed, manualTask } from '../results';
import { manualInstructions } from '../stub';
import { TEBRA_MANUAL_STEPS } from '../tebra/steps';
import {
  mapItems,
  pmClaim,
  pmEncounter,
  pmPage,
  pmPatient,
  pmPosting,
  pmRemittance,
  toClaimStatus,
  toEncounter,
  toPatient,
  toPosting,
  toRemittance,
} from './map';

export type MockProfile = 'generic' | 'tebra' | 'managed_api';

export interface MockAdapterDeps {
  baseUrl: string;
  secrets: SecretResolver;
  limiter: RateLimiter;
  /** Where uploaded 835s are kept for profiles without remittance access (Tebra). */
  fileSource?: FileSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

type Endpoint =
  'practice' | 'patients' | 'encounters' | 'claims' | 'postings' | 'remittances' | 'update' | 'payments';

/** The mock PM's documented limits per account (same numbers as apps/pm-mock src/profiles.ts). */
const LIMITS: Record<MockProfile, { names: Record<Endpoint, string>; perSecond: Record<Endpoint, number> }> =
  {
    generic: { names: plainNames(), perSecond: even(20) },
    managed_api: { names: plainNames(), perSecond: even(5) },
    tebra: {
      names: {
        practice: 'GetPractices',
        patients: 'GetPatients',
        encounters: 'GetCharges',
        claims: 'GetTransactions',
        postings: 'GetPayments',
        remittances: 'GetPayments',
        update: 'UpdateEncounterStatus',
        payments: 'CreatePayments',
      },
      perSecond: {
        practice: 2,
        patients: 1,
        encounters: 1,
        claims: 1,
        postings: 1,
        remittances: 1,
        update: 2,
        payments: 2,
      },
    },
  };

function even(n: number): Record<Endpoint, number> {
  return {
    practice: n,
    patients: n,
    encounters: n,
    claims: n,
    postings: n,
    remittances: n,
    update: n,
    payments: n,
  };
}

function plainNames(): Record<Endpoint, string> {
  return {
    practice: 'practice',
    patients: 'patients',
    encounters: 'encounters',
    claims: 'claims',
    postings: 'postings',
    remittances: 'remittances',
    update: 'encounter_update',
    payments: 'payments',
  };
}

const PM_NAME: Record<MockProfile, string> = { generic: 'the PM', tebra: 'Tebra', managed_api: 'AdvancedMD' };

interface PmError {
  error?: string;
}

function errorFor(status: number, body: PmError | null): AdapterError {
  if (status === 401) return new AdapterError('AUTH_FAILED', false, 'The PM rejected the saved credentials');
  if (status === 404 && body?.error === 'not_available') {
    return new AdapterError('UNSUPPORTED', false, 'The PM does not offer this through its API');
  }
  if (status === 404) return new AdapterError('NOT_FOUND', false, 'The PM has no such record');
  if (status === 409)
    return new AdapterError('CONFLICT', false, 'The PM refused the change in the record’s current state');
  if (status === 400 || status === 422)
    return new AdapterError('VALIDATION', false, 'The PM rejected the request');
  if (status === 429) return new AdapterError('RATE_LIMITED', true, 'The PM rate limit was reached');
  if (status === 504) return new AdapterError('TIMEOUT', true, 'The PM timed out');
  return new AdapterError('UPSTREAM_ERROR', true, `The PM returned an error (HTTP ${status})`);
}

export function createMockAdapter(deps: MockAdapterDeps): PmAdapter {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const pageSize = deps.pageSize ?? 100;
  const profiles = new Map<string, { profile: MockProfile; at: number }>();

  const practiceId = (conn: Connection) => {
    const id = conn.settings.practiceId;
    if (typeof id !== 'string' || !id)
      throw new AdapterError('VALIDATION', false, 'The connection has no PM practice ID');
    return id;
  };
  const baseUrl = (conn: Connection) =>
    typeof conn.settings.baseUrl === 'string' ? conn.settings.baseUrl : deps.baseUrl;

  async function call<T>(
    conn: Connection,
    profile: MockProfile,
    endpoint: Endpoint,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!conn.credentialsSecretRef) {
      throw new AdapterError('AUTH_FAILED', false, 'No saved credentials were found for this connection');
    }
    const key = await deps.secrets.resolve(conn.credentialsSecretRef);
    await deps.limiter.acquire(conn, LIMITS[profile].names[endpoint], LIMITS[profile].perSecond[endpoint]);
    let res: Response;
    try {
      res = await doFetch(
        `${baseUrl(conn)}/api/v1/practices/${encodeURIComponent(practiceId(conn))}${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AdapterError('TIMEOUT', true, 'The PM did not answer in time');
      }
      throw new AdapterError('UPSTREAM_ERROR', true, 'The PM could not be reached');
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new AdapterError('UPSTREAM_ERROR', true, 'The PM sent an incomplete response');
    }
    if (!res.ok) throw errorFor(res.status, json as PmError | null);
    return json as T;
  }

  async function profileOf(conn: Connection): Promise<MockProfile> {
    const cached = profiles.get(conn.id);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.profile;
    const settingsProfile = conn.settings.profile;
    const guess: MockProfile =
      settingsProfile === 'tebra' || settingsProfile === 'managed_api' ? settingsProfile : 'generic';
    const info = await call<{ profile: string }>(conn, guess, 'practice', 'GET', '');
    const profile: MockProfile =
      info?.profile === 'tebra' || info?.profile === 'managed_api' ? info.profile : 'generic';
    profiles.set(conn.id, { profile, at: Date.now() });
    return profile;
  }

  async function capsOf(conn: Connection): Promise<CapabilityMap> {
    return PROFILES[await profileOf(conn)];
  }

  async function list<T>(
    conn: Connection,
    endpoint: Endpoint,
    path: string,
    since: Date,
    cursor: string | undefined,
    parse: (raw: unknown[]) => Pick<Page<T>, 'items' | 'rejected'>,
  ): Promise<Page<T>> {
    const profile = await profileOf(conn);
    const q = new URLSearchParams({ since: since.toISOString(), limit: String(pageSize) });
    if (cursor) q.set('cursor', cursor);
    const body = pmPage.safeParse(await call(conn, profile, endpoint, 'GET', `${path}?${q}`));
    if (!body.success)
      throw new AdapterError('UPSTREAM_ERROR', true, 'The PM sent a page in an unexpected shape');
    return { ...parse(body.data.items), nextCursor: body.data.nextCursor };
  }

  const idOf = (key: string) => (item: unknown) =>
    item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string'
      ? ((item as Record<string, unknown>)[key] as string)
      : null;

  async function manual(conn: Connection, op: Operation): Promise<OpResult> {
    const profile = await profileOf(conn).catch(() => 'generic' as MockProfile);
    const tebra = profile === 'tebra' ? TEBRA_MANUAL_STEPS[op] : undefined;
    const { title, steps } = tebra
      ? { title: tebra.title, steps: tebra.steps }
      : manualInstructions(PM_NAME[profile], op);
    return manualTask(op, title, steps);
  }

  /** Runs an action if the profile allows it automatically; otherwise prepares a manual task. */
  async function action(
    conn: Connection,
    op: Operation,
    run: (profile: MockProfile) => Promise<OpResult>,
  ): Promise<OpResult> {
    try {
      const caps = await capsOf(conn);
      if (caps[op] === 0 || caps[op] === 'unavailable') return await manual(conn, op);
      return await run(await profileOf(conn));
    } catch (err) {
      if (err instanceof AdapterError) return failed(err.code, err.retryable, err.message);
      return failed('UPSTREAM_ERROR', true, 'The PM call failed');
    }
  }

  const encounterPath = (id: string, verb: string) => `/encounters/${encodeURIComponent(id)}/${verb}`;

  function correctionBody(c: ChargeCorrection) {
    const fields = new Set([
      'code',
      'modifiers',
      'units',
      'diagnosisPointers',
      'priorAuthNumber',
      'diagnoses',
    ]);
    const changes = c.changes.map((ch) => {
      const m = /^lines\[(\d+)\]\.(\w+)$/.exec(ch.field);
      const field = m ? m[2]! : ch.field;
      if (!fields.has(field)) return null;
      return {
        ...(ch.lineExternalId ? { lineId: ch.lineExternalId } : m ? { lineNumber: Number(m[1]) + 1 } : {}),
        field,
        value: ch.to,
      };
    });
    return changes.includes(null) ? null : { changes };
  }

  const paymentBody = (p: PostingInstruction) => ({
    traceNumber: p.traceNumber,
    paymentDate: p.paymentDate,
    amountCents: p.paymentAmountCents,
    lines: p.allocations.map((a) => ({
      encounterId: a.encounterExternalId,
      chargeId: a.lineExternalId,
      paidCents: a.paidCents,
      adjustments: a.adjustments.map((x) => ({ code: x.pmAdjustmentCode, amountCents: x.amountCents })),
      patientRespCents: a.patientRespCents,
    })),
  });

  return {
    key: 'mock',
    syncPolicy: { defaultIntervalMinutes: 15, preferOffHours: false },
    capabilities: capsOf,

    async healthCheck(conn) {
      const checkedAt = new Date();
      try {
        profiles.delete(conn.id);
        const caps = await capsOf(conn);
        return {
          ok: true,
          checkedAt,
          details: Object.fromEntries(
            Object.entries(caps).map(([op, level]) => [op, level === 'unavailable' ? 'untested' : 'ok']),
          ),
        };
      } catch {
        return { ok: false, checkedAt, details: {} };
      }
    },

    pullPatientsAndCoverage: (conn, since, cursor) =>
      list(conn, 'patients', '/patients', since, cursor, (raw) =>
        mapItems(raw, pmPatient, toPatient, idOf('id')),
      ),

    pullCharges: (conn, since, cursor) =>
      list(conn, 'encounters', '/encounters', since, cursor, (raw) =>
        mapItems(raw, pmEncounter, toEncounter, idOf('id')),
      ),

    pullClaimsAndStatus: (conn, since, cursor) =>
      list(conn, 'claims', '/claims', since, cursor, (raw) =>
        mapItems(raw, pmClaim, toClaimStatus, idOf('encounterId')),
      ),

    async pullRemittances(conn, since, cursor) {
      // Tebra-profile practices have no remittance files in the API: 835s are uploaded and parsed
      // with packages/x12 in M3, so until then there is nothing to read.
      const caps = await capsOf(conn);
      if (caps.pullRemittances !== 4 && caps.pullRemittances !== 2) return { items: [], nextCursor: null };
      return list(conn, 'remittances', '/remittances', since, cursor, (raw) =>
        mapItems(raw, pmRemittance, toRemittance, idOf('id')),
      );
    },

    pullPostings: (conn, since, cursor) =>
      list(conn, 'postings', '/postings', since, cursor, (raw) =>
        mapItems(raw, pmPosting, toPosting, idOf('paymentId')),
      ),

    holdCharge: (conn, encounterId) =>
      action(conn, 'holdCharge', async (profile) => {
        await call(conn, profile, 'update', 'POST', encounterPath(encounterId, 'hold'), {});
        return { ok: true };
      }),

    releaseCharge: (conn, encounterId) =>
      action(conn, 'releaseCharge', async (profile) => {
        await call(conn, profile, 'update', 'POST', encounterPath(encounterId, 'release'), {});
        return { ok: true };
      }),

    markChargeBilled: (conn, encounterId, patientControlNumber) =>
      action(conn, 'markChargeBilled', async (profile) => {
        await call(conn, profile, 'update', 'POST', encounterPath(encounterId, 'billed'), {
          patientControlNumber,
        });
        return { ok: true };
      }),

    pushChargeCorrection: (conn, correction) =>
      action(conn, 'pushChargeCorrection', async (profile) => {
        const body = correctionBody(correction);
        if (!body) return failed('VALIDATION', false, 'A change names a field the PM cannot update');
        await call(
          conn,
          profile,
          'update',
          'POST',
          encounterPath(correction.encounterExternalId, 'corrections'),
          body,
        );
        return { ok: true };
      }),

    postPayment: (conn, posting) =>
      action(conn, 'postPayment', async (profile) => {
        const res = await call<{ id: string }>(
          conn,
          profile,
          'payments',
          'POST',
          '/payments',
          paymentBody(posting),
        );
        return { ok: true, externalRef: res.id };
      }),
  };
}
