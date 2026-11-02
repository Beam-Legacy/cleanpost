import { describe, expect, it } from 'vitest';
import type { remit } from '@cleanpost/domain';
import type { SubmittedClaim } from '../src/ack';
import { pendsForRecords, respond277, type ClaimStatusRequest, type StatusRow } from '../src/claim-status';

const claim: SubmittedClaim = {
  patientControlNumber: 'TST-S1',
  payerName: 'Aetna',
  payerId: 'SIMAETNA',
  memberId: 'M1',
  dateOfService: '2026-10-01',
  renderingNpi: '1487726595',
  billingNpi: '1487726595',
  member: { status: 'active' },
  diagnoses: [{ sequence: 1, icd10: 'M17.11' }],
  lines: [{ lineNumber: 1, code: '99213', modifiers: [], units: 1, chargeCents: 13_500, pointers: [1] }],
  totalChargeCents: 13_500,
};

const req: ClaimStatusRequest = {
  tradingPartnerServiceId: 'SIMAETNA',
  providers: [{ providerType: 'BillingProvider', npi: '1487726595' }],
  subscriber: { memberId: 'M1', firstName: 'Ann', lastName: 'Test', dateOfBirth: '19800101' },
  encounter: { beginningDateOfService: '20260924', endDateOfService: '20261008' },
};

const now = new Date('2026-10-20T12:00:00Z');
const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  patientControlNumber: 'TST-S1',
  payerId: 'SIMAETNA',
  claim,
  ackStatus: 'accepted',
  ackDueAt: new Date('2026-10-02T00:00:00Z'),
  ackCodes: ['A2:20'],
  adjudication: null,
  remittance: null,
  ...over,
});
const first = (body: ReturnType<typeof respond277>) => body.claims[0]!.claimStatus as Record<string, unknown>;

describe('claim status 277 (Stedi JSON shape)', () => {
  it('says not found before the payer has the claim, or outside the dates', () => {
    expect(first(respond277(req, [], now))).toMatchObject({ statusCategoryCode: 'A4', statusCode: '35' });
    const later = row({ ackDueAt: new Date('2026-10-21T00:00:00Z') });
    expect(first(respond277(req, [later], now)).statusCategoryCode).toBe('A4');
    const outside = {
      ...req,
      encounter: { beginningDateOfService: '20261101', endDateOfService: '20261115' },
    };
    expect(first(respond277(outside, [row()], now)).statusCategoryCode).toBe('A4');
  });

  it('reports a front-end rejection with its 277CA code', () => {
    expect(first(respond277(req, [row({ ackStatus: 'rejected', ackCodes: ['A7:562'] })], now))).toMatchObject(
      {
        statusCategoryCode: 'A3',
        statusCode: '562',
        patientAccountNumber: 'TST-S1',
      },
    );
  });

  it('is in process until the payment run, or waits for records for one claim in ten', () => {
    const s = first(respond277(req, [row()], now));
    expect(s).toMatchObject({ submittedAmount: '135.00', amountPaid: '0', claimServiceDate: '20261001' });
    expect(s.statusCategoryCode).toBe(pendsForRecords('TST-S1') ? 'P3' : 'P1');
    const pcn = Array.from({ length: 50 }, (_, i) => `TST-R${i}`).find(pendsForRecords)!;
    expect(first(respond277(req, [row({ patientControlNumber: pcn })], now))).toMatchObject({
      statusCategoryCode: 'P3',
      statusCode: '21',
    });
  });

  it('reports paid or denied with the 835 trace number and date once paid', () => {
    const paid = { statusCode: '1', paidCents: 9_400 } as remit.ClaimPayment;
    const remittance = { traceNumber: 'EFT123', paymentDate: '2026-10-18' };
    expect(first(respond277(req, [row({ adjudication: paid, remittance })], now))).toMatchObject({
      statusCategoryCode: 'F1',
      statusCode: '65',
      amountPaid: '94.00',
      checkNumber: 'EFT123',
      paidDate: '2026-10-18',
    });
    const denied = { statusCode: '4', paidCents: 0 } as remit.ClaimPayment;
    expect(first(respond277(req, [row({ adjudication: denied, remittance })], now))).toMatchObject({
      statusCategoryCode: 'F2',
      statusCode: '1',
    });
  });
});
