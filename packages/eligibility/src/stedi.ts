/**
 * Stedi real-time eligibility (270/271) client (docs/15-integrations-reference.md):
 * POST {baseUrl}/2024-04-01/change/medicalnetwork/eligibility/v3 with the raw API key in
 * Authorization. In local and preview the base URL is payer-sim, which answers the same path.
 * Request and response bodies carry PHI: never logged.
 */
import { randomInt } from 'node:crypto';
import { summarize271, type EligibilitySummary } from './summary';

export interface EligibilityRequest {
  tradingPartnerServiceId: string;
  provider: { organizationName: string; npi: string };
  subscriber: { memberId: string; dateOfBirth: string; firstName: string; lastName: string };
  /** YYYYMMDD */
  dateOfService: string;
}

export type EligibilityResult =
  { ok: true; summary: EligibilitySummary } | { ok: false; retryable: boolean; code: string };

export interface EligibilityClient {
  readonly kind: 'stedi' | 'payer-sim';
  check(req: EligibilityRequest): Promise<EligibilityResult>;
}

export function createStediEligibilityClient(opts: {
  apiKey: string;
  baseUrl?: string;
  kind?: 'stedi' | 'payer-sim';
  fetch?: typeof fetch;
  timeoutMs?: number;
}): EligibilityClient {
  const base = (opts.baseUrl ?? 'https://healthcare.us.stedi.com').replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: opts.kind ?? 'stedi',
    async check(req) {
      let res: Response;
      try {
        res = await doFetch(`${base}/2024-04-01/change/medicalnetwork/eligibility/v3`, {
          method: 'POST',
          headers: { authorization: opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            controlNumber: String(randomInt(100_000_000, 999_999_999)),
            tradingPartnerServiceId: req.tradingPartnerServiceId,
            provider: req.provider,
            subscriber: req.subscriber,
            encounter: { dateOfService: req.dateOfService, serviceTypeCodes: ['30'] },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch {
        return { ok: false, retryable: true, code: 'NETWORK' };
      }
      if (res.status === 429 || res.status >= 500)
        return { ok: false, retryable: true, code: `HTTP_${res.status}` };
      const body = await res.json().catch(() => null);
      // A 4xx with AAA errors is still an answer (e.g. subscriber not found).
      if (!res.ok && !(body && typeof body === 'object' && 'errors' in body))
        return { ok: false, retryable: false, code: `HTTP_${res.status}` };
      return { ok: true, summary: summarize271(body) };
    },
  };
}
