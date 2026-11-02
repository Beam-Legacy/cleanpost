/**
 * The mock PM's own data, in its own Postgres schema (docs/05-adapters.md). This is a stand-in for a
 * practice management system: Cleanpost never reads these tables, only the REST API. Synthetic
 * data only. Timestamps keep millisecond precision so API cursors round-trip exactly.
 */
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const pm = pgSchema('pm_mock');

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
const cents = (name: string) => bigint(name, { mode: 'number' });

export interface AccountFault {
  kind: FaultKind;
  /** Requests left before the fault clears; absent = until removed or expired. */
  remaining?: number;
  until?: string;
  /** Only requests to these endpoints, e.g. "GetCharges"; absent = all. */
  endpoints?: string[];
  latencyMs?: number;
}

export type FaultKind =
  'auth_expired' | 'error_500' | 'partial_page' | 'rate_limited' | 'latency' | 'timeout';
export type ProfileKey = 'generic' | 'tebra' | 'managed_api';

/** A PM account: one API key and one rate limit, possibly several practices (a Tebra billing-company account). */
export const accounts = pm.table('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  profile: text('profile').$type<ProfileKey>().notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  faults: jsonb('faults').$type<AccountFault[]>().notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const practices = pm.table('practices', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  name: text('name').notNull(),
  specialty: text('specialty').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const providers = pm.table(
  'providers',
  {
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    npi: text('npi').notNull(),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.practiceId, t.npi] })],
);

export const locations = pm.table('locations', {
  id: text('id').primaryKey(),
  practiceId: text('practice_id')
    .notNull()
    .references(() => practices.id),
  name: text('name').notNull(),
  placeOfService: text('place_of_service').notNull(),
});

export const patients = pm.table(
  'patients',
  {
    id: text('id').primaryKey(),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: date('dob').notNull(),
    sex: text('sex').notNull(),
    address: jsonb('address').$type<{ line1: string; city: string; state: string; zip: string }>(),
    phone: text('phone'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('patients_paging_idx').on(t.practiceId, t.updatedAt, t.id)],
);

export const policies = pm.table('policies', {
  id: text('id').primaryKey(),
  practiceId: text('practice_id')
    .notNull()
    .references(() => practices.id),
  patientId: text('patient_id')
    .notNull()
    .references(() => patients.id),
  payerName: text('payer_name').notNull(),
  priority: smallint('priority').notNull(),
  memberId: text('member_id').notNull(),
  groupNumber: text('group_number'),
  relationship: text('relationship').notNull(),
  subscriber: jsonb('subscriber').$type<{ firstName: string; lastName: string; dob: string; sex: string }>(),
  effectiveDate: date('effective_date'),
  terminationDate: date('termination_date'),
});

export const encounters = pm.table(
  'encounters',
  {
    id: text('id').primaryKey(),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    patientId: text('patient_id')
      .notNull()
      .references(() => patients.id),
    dateOfService: date('date_of_service').notNull(),
    renderingNpi: text('rendering_npi').notNull(),
    referringNpi: text('referring_npi'),
    locationId: text('location_id')
      .notNull()
      .references(() => locations.id),
    placeOfService: text('place_of_service').notNull(),
    priorAuthNumber: text('prior_auth_number'),
    diagnoses: jsonb('diagnoses').$type<{ sequence: number; icd10: string }[]>().notNull(),
    /** Generic and managed profiles: open | ready | billed | void. */
    status: text('status').notNull(),
    /** Tebra profile: Draft | Review | Approved | Rejected. */
    workflowStatus: text('workflow_status'),
    onHold: boolean('on_hold').notNull().default(false),
    patientControlNumber: text('patient_control_number'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('encounters_paging_idx').on(t.practiceId, t.updatedAt, t.id)],
);

export const charges = pm.table(
  'charges',
  {
    id: text('id').primaryKey(),
    encounterId: text('encounter_id')
      .notNull()
      .references(() => encounters.id),
    lineNumber: smallint('line_number').notNull(),
    code: text('code').notNull(),
    modifiers: text('modifiers').array().notNull(),
    units: integer('units').notNull(),
    chargeCents: cents('charge_cents').notNull(),
    pointers: smallint('pointers').array().notNull(),
    ndc: text('ndc'),
  },
  (t) => [index('charges_encounter_idx').on(t.encounterId)],
);

/** The PM's view of each claim it sent through its clearinghouse. */
export const claims = pm.table(
  'claims',
  {
    encounterId: text('encounter_id')
      .primaryKey()
      .references(() => encounters.id),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    patientControlNumber: text('patient_control_number').notNull(),
    status: text('status').notNull(),
    rejectionReasons: text('rejection_reasons').array().notNull().default([]),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('claims_paging_idx').on(t.practiceId, t.updatedAt, t.encounterId)],
);

export const payments = pm.table(
  'payments',
  {
    id: text('id').primaryKey(),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    payerName: text('payer_name'),
    traceNumber: text('trace_number').notNull(),
    method: text('method').notNull().default('ACH'),
    amountCents: cents('amount_cents').notNull(),
    paymentDate: date('payment_date').notNull(),
    /** Tebra: the API creates a payment header only; lines are applied in the PM by hand. */
    headerOnly: boolean('header_only').notNull().default(false),
    /** api (written by Cleanpost) | clearinghouse (auto-posted from an 835) */
    source: text('source').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique('payments_trace_key').on(t.practiceId, t.traceNumber)],
);

export const postings = pm.table(
  'postings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id),
    encounterId: text('encounter_id')
      .notNull()
      .references(() => encounters.id),
    chargeId: text('charge_id').references(() => charges.id),
    paidCents: cents('paid_cents').notNull(),
    adjustments: jsonb('adjustments').$type<{ code: string; amountCents: number }[]>().notNull(),
    patientRespCents: cents('patient_resp_cents').notNull(),
    postedAt: ts('posted_at').notNull(),
  },
  (t) => [index('postings_paging_idx').on(t.practiceId, t.postedAt, t.id)],
);

/** ERA files the PM received from its clearinghouse (generic profile only). */
export const remittances = pm.table('remittances', {
  id: text('id').primaryKey(),
  practiceId: text('practice_id')
    .notNull()
    .references(() => practices.id),
  payload: jsonb('payload').notNull(),
  receivedAt: ts('received_at').notNull(),
});

/** The PM's own adjustment codes (Tebra-style short codes). */
export const adjustmentCodes = pm.table(
  'adjustment_codes',
  {
    practiceId: text('practice_id')
      .notNull()
      .references(() => practices.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
  },
  (t) => [primaryKey({ columns: [t.practiceId, t.code] })],
);

/** Every write Cleanpost made through the API, for the admin page. IDs and codes only. */
export const writeLog = pm.table('write_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  practiceId: text('practice_id').notNull(),
  operation: text('operation').notNull(),
  target: text('target').notNull(),
  result: text('result').notNull(),
  details: jsonb('details').notNull().default({}),
  at: ts('at').notNull().defaultNow(),
});

/** The generator's answer key: which records carry deliberate defects. Never served by the API. */
export const answerKey = pm.table(
  'answer_key',
  {
    practiceId: text('practice_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: text('record_id').notNull(),
    facts: jsonb('facts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.practiceId, t.recordType, t.recordId] })],
);

/** The clearinghouse's read position in payer-sim's 277CA feed, per practice. */
export const clearinghouseState = pm.table('clearinghouse_state', {
  practiceId: text('practice_id')
    .primaryKey()
    .references(() => practices.id),
  acksSince: ts('acks_since'),
  /** The last 835 control number read from payer-sim. */
  remitsAfter: integer('remits_after').notNull().default(0),
});
