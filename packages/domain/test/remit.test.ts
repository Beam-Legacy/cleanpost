import { describe, expect, it } from 'vitest';
import { remit, state } from '../src';

const claim = (over: Partial<remit.ClaimPayment> = {}): remit.ClaimPayment => ({
  patientControlNumber: 'LFM-E1',
  statusCode: '1',
  chargeCents: 20_000,
  paidCents: 15_000,
  patientRespCents: 0,
  payerClaimControlNumber: null,
  frequencyCode: '1',
  patient: null,
  serviceDateFrom: null,
  adjustments: [],
  remarks: [],
  lines: [],
  crossoverPayerName: null,
  ...over,
});
const line = (adjustments: remit.Adjustment[]): remit.ServiceLinePayment => ({
  code: '99213',
  modifiers: [],
  chargeCents: 20_000,
  paidCents: 0,
  units: 1,
  allowedCents: null,
  lineControlNumber: null,
  serviceDate: null,
  adjustments,
  remarks: [],
});

describe('payment outcome', () => {
  it('pays in full when only contractual and patient amounts remain', () => {
    const o = remit.paymentOutcome(
      claim({
        patientRespCents: 2000,
        lines: [
          line([
            { group: 'CO', carc: '45', amountCents: 3000 },
            { group: 'PR', carc: '1', amountCents: 2000 },
          ]),
        ],
      }),
    );
    expect(o).toEqual({ event: 'pay', balanceCents: 2000, denials: [] });
  });

  it('pays in part when a line is denied, and files the denial by category', () => {
    const o = remit.paymentOutcome(
      claim({ lines: [line([{ group: 'CO', carc: '197', amountCents: 5000 }])] }),
    );
    expect(o.event).toBe('pay_partial');
    expect(o.denials).toEqual([
      { carc: '197', group: 'CO', amountCents: 5000, category: 'auth_eligibility', lineIndex: 0 },
    ]);
    expect(remit.DENIAL_PRIORITY[o.denials[0]!.category]).toBe(1);
  });

  it('denies a claim with status 4 or nothing paid, and reverses status 22', () => {
    expect(
      remit.paymentOutcome(
        claim({
          statusCode: '4',
          paidCents: 0,
          adjustments: [{ group: 'CO', carc: '4', amountCents: 20_000 }],
        }),
      ).event,
    ).toBe('deny');
    expect(remit.denialCategory('4')).toBe('coding');
    expect(remit.paymentOutcome(claim({ statusCode: '22', paidCents: -15_000 })).event).toBe('reverse');
  });
});

describe('remittance state machine', () => {
  it('follows Mode A: received, parsed, balanced, matched, verifying, reconciled', () => {
    let s: state.RemittanceState = 'received';
    for (const e of ['parse', 'balance_ok', 'match_all', 'verify', 'posting_match'] as const) {
      const n = state.nextRemittanceState(s, e);
      expect(n.ok).toBe(true);
      if (n.ok) s = n.value;
    }
    expect(s).toBe('reconciled');
  });

  it('holds an out-of-balance 835 until an admin accepts the difference', () => {
    expect(state.nextRemittanceState('out_of_balance', 'match_all').ok).toBe(false);
    expect(state.nextRemittanceState('out_of_balance', 'accept_difference')).toEqual({
      ok: true,
      value: 'balanced',
    });
  });
});
