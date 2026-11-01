/**
 * How each mock PM profile behaves (docs/05-adapters.md). `tebra` follows Tebra's published API
 * (docs/15-integrations-reference.md): encounters move Draft -> Review -> Approved, there is no way
 * to mark a charge billed or correct it, no ERA files, payments are created as headers only, and
 * each account has per-endpoint rate limits. `generic` supports everything. `managed_api` stands in
 * for a PM reached through a third-party API: no hold or corrections, full payment posting.
 */
import type { ProfileKey } from './schema';

export type Endpoint =
  | 'practice'
  | 'patients'
  | 'encounters'
  | 'claims'
  | 'postings'
  | 'remittances'
  | 'encounter_update'
  | 'payments';

export interface ProfileRules {
  remittances: boolean;
  markBilled: boolean;
  corrections: boolean;
  /** flag: an on-hold flag; workflow: Draft/Review/Approved/Rejected; false: no hold. */
  hold: 'flag' | 'workflow' | false;
  payments: 'full' | 'header';
  /** Requests per second, per account and endpoint. */
  rates: Record<Endpoint, number>;
  /** The PM's own name for each endpoint, used in rate-limit errors. */
  endpointNames: Record<Endpoint, string>;
}

const evenly = (n: number): Record<Endpoint, number> => ({
  practice: n,
  patients: n,
  encounters: n,
  claims: n,
  postings: n,
  remittances: n,
  encounter_update: n,
  payments: n,
});

const GENERIC_NAMES: Record<Endpoint, string> = {
  practice: 'practice',
  patients: 'patients',
  encounters: 'encounters',
  claims: 'claims',
  postings: 'postings',
  remittances: 'remittances',
  encounter_update: 'encounter_update',
  payments: 'payments',
};

export const PROFILE_RULES: Record<ProfileKey, ProfileRules> = {
  generic: {
    remittances: true,
    markBilled: true,
    corrections: true,
    hold: 'flag',
    payments: 'full',
    rates: evenly(20),
    endpointNames: GENERIC_NAMES,
  },
  tebra: {
    remittances: false,
    markBilled: false,
    corrections: false,
    hold: 'workflow',
    payments: 'header',
    // Tebra's documented limits per account (docs/15-integrations-reference.md).
    rates: {
      practice: 2,
      patients: 1,
      encounters: 1,
      claims: 1,
      postings: 1,
      remittances: 1,
      encounter_update: 2,
      payments: 2,
    },
    endpointNames: {
      practice: 'GetPractices',
      patients: 'GetPatients',
      encounters: 'GetCharges',
      claims: 'GetTransactions',
      postings: 'GetPayments',
      remittances: 'GetPayments',
      encounter_update: 'UpdateEncounterStatus',
      payments: 'CreatePayments',
    },
  },
  managed_api: {
    remittances: true,
    markBilled: true,
    corrections: false,
    hold: false,
    payments: 'full',
    rates: evenly(5),
    endpointNames: GENERIC_NAMES,
  },
};

/** Generic encounter status -> Tebra workflow status, for loading generated data. */
export const TEBRA_WORKFLOW: Record<string, string> = {
  open: 'Draft',
  ready: 'Review',
  billed: 'Approved',
  void: 'Rejected',
};
