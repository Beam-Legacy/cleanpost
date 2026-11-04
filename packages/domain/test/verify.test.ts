import { describe, expect, it } from 'vitest';
import { remit } from '../src';

const lookup = remit.mappingLookup([], 'client-1');
const line: remit.ServiceLinePayment = {
  code: '99213',
  modifiers: [],
  chargeCents: 13_500,
  paidCents: 7_500,
  units: 1,
  allowedCents: 10_000,
  lineControlNumber: 'C1',
  serviceDate: '2026-10-01',
  adjustments: [
    { group: 'CO', carc: '45', amountCents: 3_500 },
    { group: 'PR', carc: '3', amountCents: 2_500 },
  ],
  remarks: [],
};
const good: remit.PmLinePosting = {
  paidCents: 7_500,
  adjustments: [
    { pmAdjustmentCode: 'CONTR', amountCents: 3_500 },
    { pmAdjustmentCode: 'COPAY', amountCents: 2_500 },
  ],
  patientRespCents: 2_500,
};
const denied: remit.ServiceLinePayment = {
  ...line,
  paidCents: 0,
  adjustments: [{ group: 'CO', carc: '197', amountCents: 13_500 }],
};

describe('posting match', () => {
  it('verifies a line posted as the 835 says, in the PM codes', () => {
    expect(remit.verifyLine(line, [good], lookup)).toEqual({ status: 'verified' });
    // Split across two postings still adds up.
    expect(
      remit.verifyLine(
        line,
        [
          { ...good, adjustments: [good.adjustments[0]!], patientRespCents: 0 },
          { paidCents: 0, adjustments: [good.adjustments[1]!], patientRespCents: 2_500 },
        ].map((p, i) => (i === 0 ? { ...p, paidCents: 7_500 } : p)),
        lookup,
      ),
    ).toEqual({ status: 'verified' });
  });

  it('reports a missing posting, a wrong code and a wrong amount', () => {
    expect(remit.verifyLine(line, [], lookup)).toEqual({ status: 'missing' });
    const wrongCode = remit.verifyLine(
      line,
      [{ ...good, adjustments: [{ pmAdjustmentCode: 'WO', amountCents: 3_500 }, good.adjustments[1]!] }],
      lookup,
    );
    expect(wrongCode).toEqual({
      status: 'mismatch',
      differences: [
        { field: 'Adjustment CONTR', expected: '$35.00', actual: 'none' },
        { field: 'Adjustment WO', expected: 'none', actual: '$35.00' },
      ],
    });
    const short = remit.verifyLine(line, [{ ...good, paidCents: 7_000 }], lookup);
    expect(short).toEqual({
      status: 'mismatch',
      differences: [{ field: 'Paid', expected: '$75.00', actual: '$70.00' }],
    });
  });

  it('expects a denial left open, and names a denial the PM wrote off', () => {
    const open = { paidCents: 0, adjustments: [], patientRespCents: 0 };
    expect(remit.verifyLine(denied, [open], lookup)).toEqual({ status: 'verified' });
    expect(
      remit.verifyLine(
        denied,
        [{ ...open, adjustments: [{ pmAdjustmentCode: 'CONTR', amountCents: 13_500 }] }],
        lookup,
      ),
    ).toEqual({
      status: 'mismatch',
      differences: [{ field: 'Denial written off', expected: 'left open', actual: '$135.00' }],
    });
  });

  it('asks for a mapping when an adjustment has none', () => {
    const odd = {
      ...line,
      adjustments: [
        ...line.adjustments.slice(0, 1),
        { group: 'OA' as const, carc: '23', amountCents: 2_500 },
      ],
    };
    expect(remit.verifyLine(odd, [good], lookup)).toEqual({ status: 'unmapped', pairs: ['OA-23'] });
  });

  it('prefers client mappings, then tenant defaults, then built-ins', () => {
    const l = remit.mappingLookup(
      [
        { clientId: null, groupCode: 'CO', carc: '45', pmAdjustmentCode: 'TCONTR', action: 'write_off' },
        {
          clientId: 'client-1',
          groupCode: 'CO',
          carc: '45',
          pmAdjustmentCode: 'CCONTR',
          action: 'write_off',
        },
        {
          clientId: 'client-2',
          groupCode: 'PR',
          carc: '1',
          pmAdjustmentCode: 'X',
          action: 'transfer_to_patient',
        },
      ],
      'client-1',
    );
    expect(l('CO', '45')?.pmAdjustmentCode).toBe('CCONTR');
    expect(l('PR', '1')?.pmAdjustmentCode).toBe('DEDUCT');
    expect(l('CO', '197')).toBeNull();
  });
});

describe('denial codes are never mapped (S-08, W-19)', () => {
  it('CO and PI that are not contractual are denials; contractual and PR, OA are not', () => {
    expect(remit.isDenialCode('CO', '4')).toBe(true);
    expect(remit.isDenialCode('PI', '204')).toBe(true);
    expect(remit.isDenialCode('CO', '45')).toBe(false);
    expect(remit.isDenialCode('CO', '253')).toBe(false);
    expect(remit.isDenialCode('PR', '1')).toBe(false);
    expect(remit.isDenialCode('OA', '23')).toBe(false);
  });
});
