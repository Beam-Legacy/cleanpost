/** Encounters, charges and versioned claims (CLAUDE.md rule 4: versions are immutable after release). */
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
import { clients } from './organization';
import { coverages, patients } from './patients';
import { locations, providers } from './practice';
import { payers } from './reference';

export const encounters = pgTable(
  'encounters',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    externalIds: jsonb('external_ids').notNull().default({}),
    dateOfService: date('date_of_service').notNull(),
    renderingProviderId: uuid('rendering_provider_id').references(() => providers.id),
    referringProviderId: uuid('referring_provider_id').references(() => providers.id),
    locationId: uuid('location_id').references(() => locations.id),
    priorAuthNumber: text('prior_auth_number'),
    /** open | ready | claimed | void */
    status: text('status').notNull().default('open'),
    /** Status in the PM, e.g. Tebra's Draft/Review/Approved/Rejected. */
    pmStatus: text('pm_status'),
    ...timestamps,
  },
  (t) => [
    index('encounters_client_dos_idx').on(t.clientId, t.dateOfService),
    check('encounters_status_check', sql`${t.status} in ('open', 'ready', 'claimed', 'void')`),
  ],
);

export const chargeLines = pgTable(
  'charge_lines',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    externalId: text('external_id'),
    lineNumber: smallint('line_number').notNull(),
    code: text('code').notNull(),
    modifiers: text('modifiers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    diagnosisPointers: smallint('diagnosis_pointers')
      .array()
      .notNull()
      .default(sql`'{}'::smallint[]`),
    units: integer('units').notNull().default(1),
    chargeCents: cents('charge_cents').notNull(),
    ndc: text('ndc'),
    lineNote: text('line_note'),
    ...timestamps,
  },
  (t) => [
    index('charge_lines_encounter_idx').on(t.encounterId),
    check('charge_lines_units_check', sql`${t.units} > 0`),
  ],
);

export const diagnoses = pgTable(
  'diagnoses',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    sequence: smallint('sequence').notNull(),
    icd10: text('icd10').notNull(),
    ...timestamps,
  },
  (t) => [unique('diagnoses_encounter_sequence_key').on(t.encounterId, t.sequence)],
);

export const claims = pgTable(
  'claims',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    payerId: uuid('payer_id').references(() => payers.id),
    coverageId: uuid('coverage_id').references(() => coverages.id),
    patientControlNumber: text('patient_control_number'),
    /** cleanpost | pm */
    pcnSource: text('pcn_source').notNull().default('cleanpost'),
    /** No FK: claim_versions references claims. */
    currentVersionId: uuid('current_version_id'),
    status: text('status').notNull().default('draft'),
    mode: text('mode').notNull(),
    totalChargeCents: cents('total_charge_cents').notNull().default(0),
    balanceCents: cents('balance_cents').notNull().default(0),
    filingDeadline: date('filing_deadline'),
    ...timestamps,
  },
  (t) => [
    unique('claims_client_pcn_key').on(t.clientId, t.patientControlNumber),
    index('claims_tenant_client_status_deadline_idx').on(t.tenantId, t.clientId, t.status, t.filingDeadline),
    check('claims_mode_check', sql`${t.mode} in ('A', 'B', 'C')`),
    check('claims_pcn_source_check', sql`${t.pcnSource} in ('cleanpost', 'pm')`),
  ],
);

export const claimVersions = pgTable(
  'claim_versions',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id),
    version: integer('version').notNull(),
    /** 1 original, 7 replacement, 8 void */
    frequencyCode: text('frequency_code').notNull().default('1'),
    originalRef: text('original_ref'),
    payload: jsonb('payload').notNull(),
    scrubResultId: uuid('scrub_result_id'),
    createdBy: text('created_by').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('claim_versions_claim_version_key').on(t.claimId, t.version),
    check('claim_versions_frequency_check', sql`${t.frequencyCode} in ('1', '7', '8')`),
  ],
);

export const claimLines = pgTable(
  'claim_lines',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    claimVersionId: uuid('claim_version_id')
      .notNull()
      .references(() => claimVersions.id),
    lineNumber: smallint('line_number').notNull(),
    lineControlNumber: text('line_control_number'),
    chargeLineId: uuid('charge_line_id').references(() => chargeLines.id),
    code: text('code').notNull(),
    modifiers: text('modifiers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    units: integer('units').notNull().default(1),
    chargeCents: cents('charge_cents').notNull(),
    dxPointers: smallint('dx_pointers')
      .array()
      .notNull()
      .default(sql`'{}'::smallint[]`),
    ...timestamps,
  },
  (t) => [unique('claim_lines_version_line_key').on(t.claimVersionId, t.lineNumber)],
);

export const scrubResults = pgTable('scrub_results', {
  id: id(),
  tenantId: tenantId(),
  clientId: clientId().references(() => clients.id),
  claimVersionId: uuid('claim_version_id')
    .notNull()
    .references(() => claimVersions.id),
  confidence: smallint('confidence').notNull(),
  findings: jsonb('findings').notNull().default([]),
  aiSummary: text('ai_summary'),
  /** auto_release | review | blocked */
  decision: text('decision').notNull(),
  rulesVersion: text('rules_version').notNull(),
  ...timestamps,
});

export const claimEvents = pgTable(
  'claim_events',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id),
    claimVersionId: uuid('claim_version_id').references(() => claimVersions.id),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    actor: text('actor').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index('claim_events_claim_idx').on(t.claimId, t.occurredAt)],
);
