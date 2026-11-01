// Adapter contract. Every PM integration implements PmAdapter.
// Core code depends only on this file and the registry.

export type AdapterKey =
  | 'mock'
  | 'manual'
  | 'file'
  | 'tebra'
  | 'athenaone'
  | 'advancedmd'
  | 'modmed'
  | 'simplepractice'
  | 'eclinicalworks'
  | 'drchrono'
  | 'collaboratemd'
  | 'officeally'
  | 'nextgen_office';

export type Operation =
  | 'pullPatientsAndCoverage'
  | 'pullCharges'
  | 'pullClaimsAndStatus'
  | 'pullRemittances'
  | 'pullPostings'
  | 'holdCharge'
  | 'releaseCharge'
  | 'markChargeBilled'
  | 'pushChargeCorrection'
  | 'postPayment';

/** 4 official API, 3 file exchange, 2 managed API, 1 browser automation, 0 manual */
export type IntegrationLevel = 0 | 1 | 2 | 3 | 4;
/**
 * 'unavailable': the PM has no equivalent and a manual task would not help
 * (e.g. holding a charge in a PM with no hold). Allowed only for holdCharge,
 * releaseCharge and markChargeBilled; see docs/05-adapters.md.
 */
export type Capability = IntegrationLevel | 'unavailable';
export type CapabilityMap = Record<Operation, Capability>;

export interface Connection {
  id: string;
  tenantId: string;
  clientId: string;
  adapterKey: AdapterKey;
  credentialsSecretRef: string | null;
  /** Connections in the same PM account (e.g. a Tebra billing-company account) share this, their credential and their rate limit. */
  pmAccountRef: string | null;
  settings: Record<string, unknown>; // e.g. Tebra practice ID
}

/** How often to pull and when. Rate limits are enforced inside the adapter through the registry's shared limiter, keyed by pmAccountRef and PM endpoint. */
export interface SyncPolicy {
  defaultIntervalMinutes: number; // sync.pull schedule unless the connection overrides it (mock 15, tebra 120)
  preferOffHours: boolean; // run backfills and large pulls outside the client's business hours
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Records on this page the adapter could not read: the PM's record ID and the field at fault, never values. */
  rejected?: { externalId: string | null; field: string }[];
}

export type AdapterErrorCode =
  | 'UNSUPPORTED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT';

export interface ManualTaskSpec {
  operation: Operation;
  title: string; // e.g. "Post payment: Aetna EFT 8841203, 14 claims"
  instructions: string[]; // step-by-step, PM-specific where known
  worksheetRef?: string; // storage key for a generated worksheet (PDF/CSV)
}

export type OpResult =
  | { ok: true; externalRef?: string }
  | { ok: false; retryable: boolean; code: AdapterErrorCode; message: string; manualTask?: ManualTaskSpec };

export interface HealthResult {
  ok: boolean;
  checkedAt: Date;
  details: Partial<Record<Operation, 'ok' | 'failing' | 'untested'>>;
}

// ---------- External (PM-shaped) records, mapped to canonical in each adapter's map.ts ----------

export interface ExtPatient {
  externalId: string;
  firstName: string;
  lastName: string;
  dob: string;
  sex: 'M' | 'F' | 'U';
  address?: { line1: string; line2?: string; city: string; state: string; zip: string };
  phone?: string;
  coverages: ExtCoverage[];
  updatedAt: string;
}

export interface ExtCoverage {
  externalId: string;
  payerName: string;
  payerExternalId?: string;
  priority: 1 | 2 | 3;
  memberId: string;
  groupNumber?: string;
  relationship: 'self' | 'spouse' | 'child' | 'other';
  subscriber?: { firstName: string; lastName: string; dob: string; sex: 'M' | 'F' | 'U' };
  effectiveDate?: string;
  terminationDate?: string;
}

export interface ExtEncounter {
  externalId: string;
  patientExternalId: string;
  dateOfService: string;
  renderingProviderNpi: string;
  referringProviderNpi?: string;
  locationExternalId: string;
  placeOfService: string;
  priorAuthNumber?: string;
  diagnoses: { sequence: number; icd10: string }[];
  lines: {
    externalId: string;
    code: string;
    modifiers: string[];
    units: number;
    chargeCents: number;
    diagnosisPointers: number[];
    ndc?: string;
  }[];
  status: 'open' | 'ready' | 'billed' | 'void';
  pmClaimStatus?: string;
  updatedAt: string;
}

export interface ExtClaimStatus {
  encounterExternalId: string;
  patientControlNumber?: string;
  status: 'queued' | 'sent' | 'accepted' | 'rejected' | 'paid' | 'denied' | 'unknown';
  rejectionReasons?: string[];
  updatedAt: string;
}

export interface ExtRemittance {
  externalId: string;
  payerName: string;
  traceNumber: string;
  paymentMethod: 'ACH' | 'CHK' | 'NON';
  paymentAmountCents: number;
  paymentDate: string;
  raw835?: string; // when the PM exposes the original file
  claims: {
    patientControlNumber: string;
    payerClaimControlNumber: string;
    statusCode: string; // CLP02
    chargeCents: number;
    paidCents: number;
    patientRespCents: number;
    adjustments: ExtAdjustment[];
    lines: {
      lineControlNumber?: string;
      code: string;
      modifiers: string[];
      units: number;
      chargeCents: number;
      allowedCents?: number;
      paidCents: number;
      adjustments: ExtAdjustment[];
      remarks: string[];
    }[];
  }[];
  providerAdjustments: { reasonCode: string; reference: string; amountCents: number }[];
}

export interface ExtAdjustment {
  groupCode: 'CO' | 'PR' | 'OA' | 'PI' | 'CR';
  carc: string;
  amountCents: number;
  quantity?: number;
}

export interface ExtPosting {
  remittanceExternalId?: string;
  traceNumber: string;
  encounterExternalId: string;
  lineExternalId?: string;
  paidCents: number;
  adjustments: { pmAdjustmentCode: string; amountCents: number }[];
  patientRespCents: number;
  postedAt: string;
}

// ---------- Instructions from the platform ----------

export interface ChargeCorrection {
  encounterExternalId: string;
  changes: { lineExternalId?: string; field: string; from: unknown; to: unknown; reason: string }[];
}

export interface PostingInstruction {
  remittanceId: string;
  traceNumber: string;
  paymentDate: string;
  paymentAmountCents: number;
  allocations: {
    encounterExternalId: string;
    lineExternalId: string;
    paidCents: number;
    adjustments: { pmAdjustmentCode: string; amountCents: number }[];
    patientRespCents: number;
    transferToSecondary: boolean;
  }[];
}

export interface PmAdapter {
  key: AdapterKey;
  syncPolicy: SyncPolicy;
  capabilities(conn: Connection): Promise<CapabilityMap>;
  healthCheck(conn: Connection): Promise<HealthResult>;

  pullPatientsAndCoverage(conn: Connection, since: Date, cursor?: string): Promise<Page<ExtPatient>>;
  pullCharges(conn: Connection, since: Date, cursor?: string): Promise<Page<ExtEncounter>>;
  pullClaimsAndStatus(conn: Connection, since: Date, cursor?: string): Promise<Page<ExtClaimStatus>>;
  pullRemittances(conn: Connection, since: Date, cursor?: string): Promise<Page<ExtRemittance>>;
  pullPostings(conn: Connection, since: Date, cursor?: string): Promise<Page<ExtPosting>>;

  holdCharge(conn: Connection, encounterExternalId: string): Promise<OpResult>;
  releaseCharge(conn: Connection, encounterExternalId: string): Promise<OpResult>;
  markChargeBilled(
    conn: Connection,
    encounterExternalId: string,
    patientControlNumber: string,
  ): Promise<OpResult>;
  pushChargeCorrection(conn: Connection, correction: ChargeCorrection): Promise<OpResult>;
  postPayment(conn: Connection, posting: PostingInstruction): Promise<OpResult>;
}
