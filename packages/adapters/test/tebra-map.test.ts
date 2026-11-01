import { describe, expect, it } from 'vitest';
import { mapChargeToClaimStatus, mapChargeToPosting, type TebraChargeData } from '../src/tebra';

/** Shaped from Tebra's ChargeData schema; values are synthetic. */
const row: TebraChargeData = {
  ID: '88123',
  EncounterID: '10443',
  EncounterProcedureID: '55021',
  EncounterStatus: 'Approved',
  PatientID: '7781',
  PracticeID: '12',
  PracticeName: 'Lakeside Family Medicine',
  ServiceStartDate: '2026-10-27',
  PostingDate: '2026-10-27',
  LastModifiedDate: '2026-10-21T14:05:00',
  ProcedureCode: '99214',
  Units: '1',
  UnitCharge: '210.00',
  TotalCharges: '210.00',
  RenderingProviderID: '3',
  Status: 'Completed',
  PrimaryInsuranceInsurancePayment: '121.12',
  PrimaryInsuranceInsuranceContractAdjustment: '58.60',
  PrimaryInsuranceInsuranceContractAdjustmentReason: '45',
  PrimaryInsuranceInsuranceCoinsurance: '30.28',
  PrimaryInsurancePaymentRef: '7730551',
  PrimaryInsurancePaymentPostingDate: '2026-10-21',
};

describe('Tebra mapping', () => {
  it('reads what Tebra posted per line, in cents', () => {
    expect(mapChargeToPosting(row)).toEqual({
      traceNumber: '7730551',
      encounterExternalId: '10443',
      lineExternalId: '55021',
      paidCents: 12112,
      adjustments: [{ pmAdjustmentCode: 'CONTRACT:45', amountCents: 5860 }],
      patientRespCents: 3028,
      postedAt: '2026-10-21',
    });
  });

  it('returns nothing when the primary payer has not paid', () => {
    expect(
      mapChargeToPosting({
        ...row,
        PrimaryInsuranceInsurancePayment: undefined,
        PrimaryInsurancePaymentRef: undefined,
      }),
    ).toBeNull();
  });

  it('maps Tebra charge status coarsely', () => {
    expect(mapChargeToClaimStatus(row).status).toBe('paid');
    expect(mapChargeToClaimStatus({ ...row, Status: 'Error – Rejection' }).status).toBe('rejected');
    expect(mapChargeToClaimStatus({ ...row, Status: 'Undefined' }).status).toBe('unknown');
  });
});
