import { describe, expect, it } from 'vitest';
import { remit } from '../src';

const lookup = remit.mappingLookup([], 'client-1');
const paid: remit.ServiceLinePayment = {
  code: '90837',
  modifiers: [],
  chargeCents: 18_000,
  paidCents: 9_500,
  units: 1,
  allowedCents: 12_000,
  lineControlNumber: null,
  serviceDate: '2026-10-14',
  adjustments: [
    { group: 'CO', carc: '45', amountCents: 6_000 },
    { group: 'PR', carc: '2', amountCents: 2_500 },
  ],
  remarks: [],
};
const denied: remit.ServiceLinePayment = {
  ...paid,
  code: '90785',
  paidCents: 0,
  adjustments: [{ group: 'CO', carc: '197', amountCents: 18_000 }],
};

describe('posting worksheet (F-02)', () => {
  it('lists each line in the PM codes, keeps denials open and flags secondaries', () => {
    const w = remit.postingWorksheet(
      [
        {
          patientControlNumber: 'RBC-1',
          dateOfService: '2026-10-14',
          hasSecondary: true,
          lines: [paid, denied],
        },
      ],
      lookup,
    );
    expect(w.unmapped).toEqual([]);
    expect(w.rows).toEqual([
      {
        patientControlNumber: 'RBC-1',
        dateOfService: '2026-10-14',
        code: '90837',
        paid: '$95.00',
        adjustments: 'CONTR $60.00; COINS $25.00',
        patientResponsibility: '$25.00',
        note: 'Bill the secondary payer before the patient',
      },
      {
        patientControlNumber: 'RBC-1',
        dateOfService: '2026-10-14',
        code: '90785',
        paid: '$0.00',
        adjustments: '',
        patientResponsibility: '$0.00',
        note: 'Denied $180.00: leave open, do not write off',
      },
    ]);
    const csv = remit.worksheetCsv(w).split('\r\n');
    expect(csv).toHaveLength(3);
    expect(csv[0]).toBe(
      '"Control number","Date of service","Code","Paid","Adjustments (PM codes)","Patient responsibility","Note"',
    );
  });

  it('names the codes that have no PM code yet', () => {
    const odd = { ...paid, adjustments: [{ group: 'OA' as const, carc: '23', amountCents: 8_500 }] };
    const w = remit.postingWorksheet(
      [{ patientControlNumber: 'RBC-2', dateOfService: null, hasSecondary: false, lines: [odd] }],
      lookup,
    );
    expect(w.unmapped).toEqual(['OA-23']);
    expect(w.rows[0]!.note).toBe('No PM code for OA-23');
  });
});
