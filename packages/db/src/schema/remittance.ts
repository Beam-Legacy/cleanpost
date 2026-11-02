/** 835 remittances, matching and posting (docs/07-remittance-posting.md). Money in cents. */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { cents, clientId, id, tenantId, timestamps } from './_columns';
import { claimLines, claims } from './claims';
import { clients } from './organization';
import { payers } from './reference';

export const remittances = pgTable(
  'remittances',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    payerId: uuid('payer_id').references(() => payers.id),
    payerName: text('payer_name').notNull(),
    /** stedi | pm | file */
    source: text('source').notNull(),
    traceNumber: text('trace_number').notNull(),
    /** ACH | CHK | NON */
    paymentMethod: text('payment_method').notNull(),
    paymentAmountCents: cents('payment_amount_cents').notNull(),
    paymentDate: date('payment_date').notNull(),
    rawRef: text('raw_ref'),
    /** docs/03-state-machines.md: received ... reconciled */
    status: text('status').notNull().default('received'),
    ...timestamps,
  },
  (t) => [
    // Idempotent ingestion on (payer, trace, amount, date): docs/07-remittance-posting.md
    unique('remittances_idempotency_key').on(
      t.clientId,
      t.payerName,
      t.traceNumber,
      t.paymentAmountCents,
      t.paymentDate,
    ),
    check('remittances_method_check', sql`${t.paymentMethod} in ('ACH', 'CHK', 'NON')`),
  ],
);

export const remitClaims = pgTable(
  'remit_claims',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    remittanceId: uuid('remittance_id')
      .notNull()
      .references(() => remittances.id),
    claimId: uuid('claim_id').references(() => claims.id),
    patientControlNumber: text('patient_control_number'),
    payerClaimControlNumber: text('payer_claim_control_number'),
    claimStatusCode: text('claim_status_code').notNull(),
    chargeCents: cents('charge_cents').notNull(),
    paidCents: cents('paid_cents').notNull(),
    patientRespCents: cents('patient_resp_cents').notNull().default(0),
    /** matched | unmatched | ambiguous */
    matchStatus: text('match_status').notNull().default('unmatched'),
    /** pcn | payer_claim_number | heuristic | manual */
    matchedBy: text('matched_by'),
    ...timestamps,
  },
  (t) => [
    index('remit_claims_pcn_idx').on(t.patientControlNumber),
    index('remit_claims_remittance_idx').on(t.remittanceId),
  ],
);

export const remitLines = pgTable('remit_lines', {
  id: id(),
  tenantId: tenantId(),
  clientId: clientId().references(() => clients.id),
  remitClaimId: uuid('remit_claim_id')
    .notNull()
    .references(() => remitClaims.id),
  claimLineId: uuid('claim_line_id').references(() => claimLines.id),
  code: text('code').notNull(),
  modifiers: text('modifiers')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  chargeCents: cents('charge_cents').notNull(),
  allowedCents: cents('allowed_cents'),
  paidCents: cents('paid_cents').notNull(),
  units: integer('units').notNull().default(1),
  lineControlNumber: text('line_control_number'),
  /**
   * Posting match (Modes A, C; docs/07-remittance-posting.md): null until checked, then
   * pending (the PM has not posted the payment yet) | verified | mismatch | missing | unmapped.
   */
  verifyStatus: text('verify_status'),
  /** What differs, in the PM's codes: [{ field, expected, actual }]. Amounts and codes only. */
  verifyDetail: jsonb('verify_detail').$type<{ field: string; expected: string; actual: string }[]>(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  ...timestamps,
});

export const remitAdjustments = pgTable(
  'remit_adjustments',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    remitClaimId: uuid('remit_claim_id').references(() => remitClaims.id),
    remitLineId: uuid('remit_line_id').references(() => remitLines.id),
    /** CO | PR | OA | PI | CR */
    groupCode: text('group_code').notNull(),
    carc: text('carc').notNull(),
    amountCents: cents('amount_cents').notNull(),
    quantity: integer('quantity'),
    ...timestamps,
  },
  (t) => [
    check('remit_adjustments_parent_check', sql`num_nonnulls(${t.remitClaimId}, ${t.remitLineId}) = 1`),
    check('remit_adjustments_group_check', sql`${t.groupCode} in ('CO', 'PR', 'OA', 'PI', 'CR')`),
  ],
);

export const remitRemarks = pgTable(
  'remit_remarks',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    remitClaimId: uuid('remit_claim_id').references(() => remitClaims.id),
    remitLineId: uuid('remit_line_id').references(() => remitLines.id),
    rarc: text('rarc').notNull(),
    ...timestamps,
  },
  (t) => [check('remit_remarks_parent_check', sql`num_nonnulls(${t.remitClaimId}, ${t.remitLineId}) = 1`)],
);

export const providerAdjustments = pgTable('provider_adjustments', {
  id: id(),
  tenantId: tenantId(),
  clientId: clientId().references(() => clients.id),
  remittanceId: uuid('remittance_id')
    .notNull()
    .references(() => remittances.id),
  reasonCode: text('reason_code').notNull(),
  reference: text('reference'),
  amountCents: cents('amount_cents').notNull(),
  ...timestamps,
});

/** Group code + CARC to the PM's own adjustment code. client_id null = tenant default for that PM type. */
export const adjustmentMappings = pgTable(
  'adjustment_mappings',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: uuid('client_id').references(() => clients.id),
    pmType: text('pm_type').notNull(),
    groupCode: text('group_code').notNull(),
    carc: text('carc').notNull(),
    pmAdjustmentCode: text('pm_adjustment_code').notNull(),
    /** adjust | transfer_to_patient | write_off | info_only */
    action: text('action').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('adjustment_mappings_key')
      .on(t.tenantId, t.clientId, t.pmType, t.groupCode, t.carc)
      .nullsNotDistinct(),
  ],
);

export const postings = pgTable('postings', {
  id: id(),
  tenantId: tenantId(),
  clientId: clientId().references(() => clients.id),
  remittanceId: uuid('remittance_id')
    .notNull()
    .references(() => remittances.id),
  connectionId: uuid('connection_id').notNull(),
  /** pending | in_progress | succeeded | failed | manual_required */
  status: text('status').notNull().default('pending'),
  /** api | file | browser | manual | pm_native */
  method: text('method').notNull(),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
  postedTotalCents: cents('posted_total_cents').notNull().default(0),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  ...timestamps,
});

/**
 * What the PM posted, read back with `pullPostings` (Modes A, C): one row per posting line, in the
 * PM's own adjustment codes. Compared with the 835 per line by the posting match.
 */
export const pmPostings = pgTable(
  'pm_postings',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    connectionId: uuid('connection_id').notNull(),
    /** Stable key from the posting's own fields, so a re-read is not stored twice. */
    externalKey: text('external_key').notNull(),
    traceNumber: text('trace_number').notNull(),
    encounterExternalId: text('encounter_external_id').notNull(),
    lineExternalId: text('line_external_id'),
    paidCents: cents('paid_cents').notNull(),
    adjustments: jsonb('adjustments').$type<{ pmAdjustmentCode: string; amountCents: number }[]>().notNull(),
    patientRespCents: cents('patient_resp_cents').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique('pm_postings_key').on(t.connectionId, t.externalKey),
    index('pm_postings_trace_idx').on(t.clientId, t.traceNumber),
  ],
);
