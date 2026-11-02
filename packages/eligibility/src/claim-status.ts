/**
 * Stedi real-time claim status (276/277) client (docs/15-integrations-reference.md):
 * POST {baseUrl}/2024-04-01/change/medicalnetwork/claimstatus/v2 with the raw API key in
 * Authorization. Stedi's test keys do not cover claim status, so local and preview point the base
 * URL at payer-sim, which answers the same path from what it received and decided. The response is
 * validated here (CLAUDE.md: Zod at the boundary) and normalized: amounts in cents, dates YYYY-MM-DD.
 * Request and response bodies carry PHI: never logged.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { claimStatus } from '@cleanpost/domain';

export interface ClaimStatusRequest {
  tradingPartnerServiceId: string;
  billingProvider: { organizationName: string; npi: string };
  subscriber: { memberId: string; firstName: string; lastName: string; dateOfBirth: string };
  /** YYYYMMDD: the date of service plus and minus 7 days, never in the future (Stedi's advice). */
  beginningDateOfService: string;
  endDateOfService: string;
}

export type ClaimStatusResponse =
  { ok: true; claims: claimStatus.ClaimStatusResult[] } | { ok: false; retryable: boolean; code: string };

export interface ClaimStatusClient {
  readonly kind: 'stedi' | 'payer-sim';
  check(req: ClaimStatusRequest, opts?: { timeoutMs?: number }): Promise<ClaimStatusResponse>;
}

const amount = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  });
const date = z
  .string()
  .nullish()
  .transform((v) => {
    if (!v) return null;
    const d = v.replaceAll('-', '').slice(0, 8);
    return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
  });
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const responseSchema = z.object({
  claims: z
    .array(
      z.object({
        claimStatus: z
          .object({
            statusCategoryCode: z.string().min(1),
            statusCode: text,
            entityCode: text,
            effectiveDate: date,
            tradingPartnerClaimNumber: text,
            patientAccountNumber: text,
            submittedAmount: amount,
            amountPaid: amount,
            paidDate: date,
            checkNumber: text,
            checkIssueDate: date,
          })
          .nullish(),
      }),
    )
    .nullish(),
  errorResponse: z.object({ code: z.string().nullish() }).nullish(),
});

export function createStediClaimStatusClient(opts: {
  apiKey: string;
  baseUrl?: string;
  kind?: 'stedi' | 'payer-sim';
  fetch?: typeof fetch;
}): ClaimStatusClient {
  const base = (opts.baseUrl ?? 'https://healthcare.us.stedi.com').replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: opts.kind ?? 'stedi',
    async check(req, o = {}) {
      let res: Response;
      try {
        res = await doFetch(`${base}/2024-04-01/change/medicalnetwork/claimstatus/v2`, {
          method: 'POST',
          headers: { authorization: opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            controlNumber: String(randomInt(100_000_000, 999_999_999)),
            tradingPartnerServiceId: req.tradingPartnerServiceId,
            providers: [{ providerType: 'BillingProvider', ...req.billingProvider }],
            subscriber: req.subscriber,
            encounter: {
              beginningDateOfService: req.beginningDateOfService,
              endDateOfService: req.endDateOfService,
            },
          }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        });
      } catch {
        return { ok: false, retryable: true, code: 'NETWORK' };
      }
      if (res.status === 429 || res.status >= 500)
        return { ok: false, retryable: true, code: `HTTP_${res.status}` };
      if (!res.ok) return { ok: false, retryable: false, code: `HTTP_${res.status}` };
      const body = responseSchema.safeParse(await res.json().catch(() => null));
      if (!body.success) return { ok: false, retryable: false, code: 'BAD_RESPONSE' };
      if (body.data.errorResponse && !body.data.claims?.length)
        return { ok: false, retryable: true, code: `PAYER_${body.data.errorResponse.code ?? 'ERROR'}` };
      return {
        ok: true,
        claims: (body.data.claims ?? []).flatMap((c) =>
          c.claimStatus
            ? [
                {
                  category: c.claimStatus.statusCategoryCode,
                  code: c.claimStatus.statusCode,
                  entityCode: c.claimStatus.entityCode,
                  effectiveDate: c.claimStatus.effectiveDate,
                  payerClaimNumber: c.claimStatus.tradingPartnerClaimNumber,
                  patientAccountNumber: c.claimStatus.patientAccountNumber,
                  submittedCents: c.claimStatus.submittedAmount,
                  paidCents: c.claimStatus.amountPaid,
                  paidDate: c.claimStatus.paidDate,
                  checkNumber: c.claimStatus.checkNumber,
                  checkIssueDate: c.claimStatus.checkIssueDate,
                },
              ]
            : [],
        ),
      };
    },
  };
}
