import { describe, expect, it } from 'vitest';
import { remit } from '@cleanpost/domain';
import type { SubmittedClaim } from '../src/ack';
import { adjudicate, type AdjudicationInput } from '../src/adjudicate';
import { PAYERS } from '../src/payers';
import { reversalOf } from '../src/payments';
import { loadNcci } from '../src/reference';

const ncci = loadNcci();

const claim = (over: Partial<SubmittedClaim> = {}): SubmittedClaim => ({
  patientControlNumber: 'TST-E1',
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
  ...over,
});

const input = (over: Partial<AdjudicationInput> = {}): AdjudicationInput => ({
  claim: claim(),
  payer: PAYERS.SIMAETNA!,
  member: {
    status: 'active',
    planBegin: '20260101',
    planEnd: null,
    copayCents: 2500,
    deductibleRemainingCents: 5000,
    coinsurancePercent: 20,
  },
  receivedAt: new Date('2026-10-05T00:00:00Z'),
  duplicate: false,
  ncci,
  ...over,
});

const balances = (p: remit.ClaimPayment) =>
  remit.balance835({
    payment: { method: 'ACH', amountCents: p.paidCents, paymentDate: '2026-10-20', traceNumber: 'T' },
    payer: { name: 'P', id: null },
    payee: { name: 'X', npi: null },
    claims: [p],
    providerAdjustments: [],
  }).balanced;

describe('adjudicate', () => {
  it('pays an office visit less the contractual write-off and the copay', () => {
    const { payment } = adjudicate(input());
    const line = payment.lines[0]!;
    expect(payment.statusCode).toBe('1');
    expect(line.adjustments.map((a) => `${a.group}-${a.carc}`)).toEqual(['CO-45', 'PR-3']);
    expect(payment.patientRespCents).toBe(2500);
    expect(line.paidCents).toBe(line.allowedCents! - 2500);
    expect(balances(payment)).toBe(true);
  });

  it('takes deductible then coinsurance on a procedure', () => {
    const c = claim({
      lines: [
        { lineNumber: 1, code: '20610', modifiers: ['RT'], units: 1, chargeCents: 14_500, pointers: [1] },
      ],
      totalChargeCents: 14_500,
    });
    const { payment, deductibleUsedCents } = adjudicate(input({ claim: c }));
    expect(payment.lines[0]!.adjustments.map((a) => `${a.group}-${a.carc}`)).toEqual([
      'CO-45',
      'PR-1',
      'PR-2',
    ]);
    expect(deductibleUsedCents).toBe(5000);
    expect(balances(payment)).toBe(true);
  });

  it('denies an office visit billed with a procedure and no modifier 25 (CO-4)', () => {
    const c = claim({
      lines: [
        { lineNumber: 1, code: '99213', modifiers: [], units: 1, chargeCents: 13_500, pointers: [1] },
        { lineNumber: 2, code: '20610', modifiers: ['RT'], units: 1, chargeCents: 14_500, pointers: [1] },
      ],
      totalChargeCents: 28_000,
    });
    const { payment } = adjudicate(input({ claim: c }));
    expect(payment.lines[0]!.adjustments).toEqual([{ group: 'CO', carc: '4', amountCents: 13_500 }]);
    expect(payment.lines[0]!.remarks).toEqual(['N822']);
    expect(payment.lines[1]!.paidCents).toBeGreaterThan(0);
    expect(payment.statusCode).toBe('1');
    expect(balances(payment)).toBe(true);
  });

  it('bundles an NCCI column-2 code (CO-97) and denies a missing authorization (CO-197)', () => {
    const bundled = adjudicate(
      input({
        claim: claim({
          lines: [
            { lineNumber: 1, code: '20610', modifiers: ['RT'], units: 1, chargeCents: 14_500, pointers: [1] },
            { lineNumber: 2, code: '76942', modifiers: [], units: 1, chargeCents: 11_000, pointers: [1] },
          ],
          totalChargeCents: 25_500,
        }),
      }),
    ).payment;
    expect(bundled.lines[1]!.adjustments[0]!.carc).toBe('97');
    const noAuth = adjudicate(
      input({
        claim: claim({
          lines: [
            {
              lineNumber: 1,
              code: '29881',
              modifiers: ['RT'],
              units: 1,
              chargeCents: 250_000,
              pointers: [1],
            },
          ],
          totalChargeCents: 250_000,
        }),
      }),
    ).payment;
    expect(noAuth.statusCode).toBe('4');
    expect(noAuth.lines[0]!.adjustments[0]!.carc).toBe('197');
  });

  it('denies the whole claim for inactive coverage, late filing and duplicates', () => {
    const member = { ...input().member!, status: 'inactive' };
    expect(adjudicate(input({ member })).payment.lines[0]!.adjustments[0]!.carc).toBe('27');
    expect(
      adjudicate(input({ receivedAt: new Date('2027-06-01T00:00:00Z') })).payment.lines[0]!.adjustments[0]!
        .carc,
    ).toBe('29');
    expect(adjudicate(input({ duplicate: true })).payment.statusCode).toBe('4');
    expect(adjudicate(input({ member: null })).payment.lines[0]!.adjustments[0]!.carc).toBe('31');
  });

  it('reverses a payment with every amount negated, still balanced', () => {
    const r = reversalOf(adjudicate(input()).payment);
    expect(r.statusCode).toBe('22');
    expect(r.paidCents).toBeLessThan(0);
    expect(balances(r)).toBe(true);
  });

  it('denies about 2.5% of first-submission lines for reasons no scrub can see, and never a correction', () => {
    const carcs = new Map<string, number>();
    let lines = 0;
    for (let i = 0; i < 4000; i++) {
      const c = claim({ patientControlNumber: `TST-E${i}` });
      const p = adjudicate(input({ claim: c })).payment;
      lines++;
      const deny = p.lines[0]!.adjustments.find((a) => a.group === 'CO' && a.carc !== '45');
      if (deny) carcs.set(deny.carc, (carcs.get(deny.carc) ?? 0) + 1);
      expect(balances(p)).toBe(true);
      const again = adjudicate(input({ claim: { ...c, frequencyCode: '7' } })).payment;
      expect(again.lines[0]!.adjustments.some((a) => a.group === 'CO' && a.carc !== '45')).toBe(false);
    }
    const denied = [...carcs.values()].reduce((s, n) => s + n, 0);
    expect(denied / lines).toBeGreaterThan(0.015);
    expect(denied / lines).toBeLessThan(0.035);
    expect([...carcs.keys()].sort()).toEqual(['16', '22', '50', '96']);
  });
});
