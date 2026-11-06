import 'server-only';
/**
 * The payer simulator's clock, for demos and tests in local and preview only (docs/12-testing.md).
 * Never available in staging or production: there is no payer-sim there, and this refuses to run.
 */

export interface SimConfig {
  payerSimUrl: string;
  payerSimToken: string | null;
  pmMockUrl: string | null;
  pmMockAdminPassword: string | null;
}

export function simConfig(): SimConfig | null {
  const env = process.env.CLEANPOST_ENV ?? 'local';
  if (env !== 'local' && env !== 'preview') return null;
  const url = process.env.PAYER_SIM_URL;
  if (!url) return null;
  return {
    payerSimUrl: url.replace(/\/$/, ''),
    payerSimToken: process.env.PAYER_SIM_TOKEN ?? null,
    pmMockUrl: process.env.PM_MOCK_URL?.replace(/\/$/, '') ?? null,
    pmMockAdminPassword: process.env.PM_MOCK_ADMIN_PASSWORD ?? null,
  };
}

const auth = (c: SimConfig): Record<string, string> =>
  c.payerSimToken ? { authorization: `Bearer ${c.payerSimToken}` } : {};

/** The simulated date, or null if payer-sim does not answer quickly (the page still renders). */
export async function simNow(c: SimConfig): Promise<Date | null> {
  try {
    const res = await fetch(`${c.payerSimUrl}/clock`, {
      headers: auth(c),
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return new Date(((await res.json()) as { now: string }).now);
  } catch {
    return null;
  }
}

export async function advanceSimClock(c: SimConfig, days: number): Promise<Date> {
  const res = await fetch(`${c.payerSimUrl}/clock/advance?days=${days}`, {
    method: 'POST',
    headers: auth(c),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`payer-sim refused the clock change: ${res.status}`);
  return new Date(((await res.json()) as { now: string }).now);
}

/** Runs the mock PM's clearinghouse once (claims out, 277CAs and 835s in); false if not reachable. */
export async function runClearinghouse(c: SimConfig, opts: { bill: boolean }): Promise<boolean> {
  if (!c.pmMockUrl || !c.pmMockAdminPassword) return false;
  try {
    const res = await fetch(`${c.pmMockUrl}/admin/api/clearinghouse/run${opts.bill ? '?bill=1' : ''}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`admin:${c.pmMockAdminPassword}`).toString('base64')}` },
      signal: AbortSignal.timeout(60_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The patient's insurance card as the mock PM knows it (P-04 demo, DEC-31). */
export interface SampleCard {
  payerName: string;
  memberId: string;
  groupNumber: string | null;
  subscriberName: string;
  planType: string;
  rxBin: string;
  payerPhone: string;
}

/** What the mock PM's patient's primary card says; null when not reachable or not found. */
export async function sampleCard(
  c: SimConfig,
  practiceId: string,
  patientExternalId: string,
): Promise<SampleCard | null> {
  if (!c.pmMockUrl || !c.pmMockAdminPassword) return null;
  try {
    const res = await fetch(
      `${c.pmMockUrl}/admin/api/practices/${encodeURIComponent(practiceId)}/patients/${encodeURIComponent(patientExternalId)}/card`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${c.pmMockAdminPassword}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      },
    );
    return res.ok ? ((await res.json()) as SampleCard) : null;
  } catch {
    return null;
  }
}

/** Demo: expire (or restore) the PM login behind one mock-PM practice; false if not reachable. */
export async function setPracticeLoginExpired(c: SimConfig, practiceId: string, expired: boolean) {
  if (!c.pmMockUrl || !c.pmMockAdminPassword) return false;
  try {
    const res = await fetch(`${c.pmMockUrl}/admin/api/practices/${encodeURIComponent(practiceId)}/faults`, {
      method: expired ? 'POST' : 'DELETE',
      headers: {
        authorization: `Basic ${Buffer.from(`admin:${c.pmMockAdminPassword}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      ...(expired ? { body: JSON.stringify({ kind: 'auth_expired' }) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
