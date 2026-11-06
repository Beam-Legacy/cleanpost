/** Patients, coverage and documents. PHI: read and write only through withAudit (CLAUDE.md rule 7). */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { clientId, id, tenantId, timestamps } from './_columns';
import { clients } from './organization';
import { payers } from './reference';

export const patients = pgTable(
  'patients',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    /** { [connectionId]: externalId } */
    externalIds: jsonb('external_ids').notNull().default({}),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: date('dob').notNull(),
    /** M | F | U */
    sex: text('sex').notNull().default('U'),
    address: jsonb('address'),
    phone: text('phone'),
    /** pm, or user: a person corrected it in Cleanpost (P-06) and the PM does not show it yet (DEC-30). */
    source: text('source').notNull().default('pm'),
    ...timestamps,
  },
  (t) => [
    index('patients_client_name_idx').on(t.clientId, t.lastName, t.firstName),
    check('patients_sex_check', sql`${t.sex} in ('M', 'F', 'U')`),
    check('patients_source_check', sql`${t.source} in ('pm', 'user')`),
  ],
);

export const coverages = pgTable(
  'coverages',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    payerId: uuid('payer_id').references(() => payers.id),
    /** As named in the PM, kept when no payer mapping exists yet. */
    payerName: text('payer_name').notNull(),
    priority: smallint('priority').notNull(),
    /** Field-encrypted; memberIdLast4 is for masked display (C-06). */
    memberIdEncrypted: text('member_id_encrypted').notNull(),
    memberIdLast4: text('member_id_last4').notNull(),
    groupNumber: text('group_number'),
    /** self | spouse | child | other */
    relationship: text('relationship').notNull().default('self'),
    subscriber: jsonb('subscriber'),
    effectiveDate: date('effective_date'),
    terminationDate: date('termination_date'),
    /** pm | card | user. card and user: corrected in Cleanpost (P-02, P-05), not yet shown by the PM (DEC-30). */
    source: text('source').notNull().default('pm'),
    ...timestamps,
  },
  (t) => [
    index('coverages_patient_idx').on(t.patientId),
    check('coverages_priority_check', sql`${t.priority} between 1 and 3`),
  ],
);

export const eligibilityChecks = pgTable(
  'eligibility_checks',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    coverageId: uuid('coverage_id')
      .notNull()
      .references(() => coverages.id),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .default(sql`app.now()`),
    /** active | inactive | error | unknown */
    status: text('status').notNull(),
    summary: jsonb('summary').notNull().default({}),
    rawRef: text('raw_ref'),
    ...timestamps,
  },
  (t) => [index('eligibility_checks_coverage_idx').on(t.coverageId, t.requestedAt)],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    patientId: uuid('patient_id').references(() => patients.id),
    /** insurance_card_front | insurance_card_back | payer_letter | eob | other */
    type: text('type').notNull(),
    storageKey: text('storage_key').notNull(),
    extracted: jsonb('extracted'),
    extractionConfidence: numeric('extraction_confidence', { precision: 4, scale: 3 }),
    /** pending | accepted | corrected | rejected */
    reviewStatus: text('review_status').notNull().default('pending'),
    ...timestamps,
  },
  (t) => [index('documents_patient_idx').on(t.patientId)],
);
