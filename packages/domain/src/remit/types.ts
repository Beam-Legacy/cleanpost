/**
 * The canonical 835 (docs/07-remittance-posting.md): what Cleanpost needs from a remittance,
 * whether it came from Stedi's JSON, a PM, or an X12 file. Money in integer cents; dates YYYY-MM-DD.
 * Patient names are PHI: they stay in the database and are never logged.
 */

export type GroupCode = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';

export interface Adjustment {
  group: GroupCode;
  /** CARC, e.g. "45", "1", "197". */
  carc: string;
  amountCents: number;
  quantity?: number;
}

export interface ServiceLinePayment {
  /** SVC01-2: the procedure code; codes only. */
  code: string;
  modifiers: string[];
  chargeCents: number;
  paidCents: number;
  units: number;
  allowedCents: number | null;
  /** REF*6R: Cleanpost's line control number, for exact line matching. */
  lineControlNumber: string | null;
  serviceDate: string | null;
  adjustments: Adjustment[];
  /** LQ*HE remark codes (RARC). */
  remarks: string[];
}

export interface ClaimPayment {
  /** CLP01: our patient control number. */
  patientControlNumber: string;
  /**
   * CLP02: 1 processed as primary, 2 secondary, 3 tertiary, 4 denied, 19-21 processed and
   * forwarded, 22 reversal of a previous payment, 23 not our claim.
   */
  statusCode: string;
  chargeCents: number;
  paidCents: number;
  patientRespCents: number;
  /** CLP07: the payer's claim control number. */
  payerClaimControlNumber: string | null;
  /** CLP09: frequency code of the claim the payer processed. */
  frequencyCode: string | null;
  patient: { lastName: string; firstName: string } | null;
  serviceDateFrom: string | null;
  adjustments: Adjustment[];
  remarks: string[];
  lines: ServiceLinePayment[];
  /** NM1*TT: another payer the claim was forwarded to (crossover). */
  crossoverPayerName: string | null;
}

export interface ProviderAdjustment {
  /** PLB03-1, e.g. L6 interest, WO overpayment recovery, FB forwarding balance. */
  reasonCode: string;
  reference: string | null;
  /** Positive reduces the payment (recoupment); negative adds to it (interest). */
  amountCents: number;
}

export interface Remittance835 {
  payment: {
    /** BPR04: ACH, CHK or NON (no payment). */
    method: 'ACH' | 'CHK' | 'NON';
    amountCents: number;
    paymentDate: string;
    /** TRN02: the check or EFT trace number. */
    traceNumber: string;
  };
  payer: { name: string; id: string | null };
  payee: { name: string; npi: string | null };
  claims: ClaimPayment[];
  providerAdjustments: ProviderAdjustment[];
}
