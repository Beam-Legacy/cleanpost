import { describe, expect, it } from 'vitest';
import { createStediClaimStatusClient, type ClaimStatusRequest } from '../src';

const req: ClaimStatusRequest = {
  tradingPartnerServiceId: '00540',
  billingProvider: { organizationName: 'Test Practice', npi: '1487726595' },
  subscriber: { memberId: 'M1', firstName: 'Ann', lastName: 'Test', dateOfBirth: '19800101' },
  beginningDateOfService: '20260924',
  endDateOfService: '20261008',
};

function client(status: number, body: unknown, seen: { url?: string; body?: unknown } = {}) {
  return createStediClaimStatusClient({
    apiKey: 'test-key',
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
}

describe('Stedi claim status client', () => {
  it('sends the 276 to Stedi’s path and normalizes the 277', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const res = await client(
      200,
      {
        claims: [
          {
            claimStatus: {
              statusCategoryCode: 'F1',
              statusCode: '65',
              entityCode: '41',
              effectiveDate: '2026-10-20',
              tradingPartnerClaimNumber: 'MD26-8810442',
              patientAccountNumber: 'CPD-26-002210',
              submittedAmount: '410.00',
              amountPaid: 312.5,
              paidDate: '20261020',
              checkNumber: 'EFT77',
              checkIssueDate: '2026-10-21',
            },
          },
        ],
      },
      seen,
    ).check(req);
    expect(seen.url).toBe('https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v2');
    expect(seen.body).toMatchObject({
      tradingPartnerServiceId: '00540',
      providers: [{ providerType: 'BillingProvider', npi: '1487726595' }],
      encounter: { beginningDateOfService: '20260924', endDateOfService: '20261008' },
    });
    expect(res).toEqual({
      ok: true,
      claims: [
        {
          category: 'F1',
          code: '65',
          entityCode: '41',
          effectiveDate: '2026-10-20',
          payerClaimNumber: 'MD26-8810442',
          patientAccountNumber: 'CPD-26-002210',
          submittedCents: 41_000,
          paidCents: 31_250,
          paidDate: '2026-10-20',
          checkNumber: 'EFT77',
          checkIssueDate: '2026-10-21',
        },
      ],
    });
  });

  it('retries throttling, outages and a payer that could not answer; not a bad request', async () => {
    expect(await client(429, {}).check(req)).toEqual({ ok: false, retryable: true, code: 'HTTP_429' });
    expect(await client(503, {}).check(req)).toEqual({ ok: false, retryable: true, code: 'HTTP_503' });
    expect(await client(400, { message: 'bad' }).check(req)).toEqual({
      ok: false,
      retryable: false,
      code: 'HTTP_400',
    });
    expect(await client(200, { errorResponse: { code: '42' } }).check(req)).toEqual({
      ok: false,
      retryable: true,
      code: 'PAYER_42',
    });
    expect(await client(200, { claims: [{ claimStatus: { statusCode: '1' } }] }).check(req)).toEqual({
      ok: false,
      retryable: false,
      code: 'BAD_RESPONSE',
    });
  });
});
