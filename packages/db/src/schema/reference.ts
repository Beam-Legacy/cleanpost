/** Global reference data: no tenant, no PHI (docs/02-data-model.md). */
import { boolean, date, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_columns';

export const payers = pgTable(
  'payers',
  {
    id: id(),
    stediPayerId: text('stedi_payer_id').unique(),
    name: text('name').notNull(),
    aliases: text('aliases').array().notNull().default([]),
    /** { eligibility, claims, era, status } */
    supports: jsonb('supports').notNull().default({}),
    enrollmentRequired: boolean('enrollment_required').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('payers_name_idx').on(t.name)],
);

/** Code sets with our own plain-language labels. CPT rows carry codes only until the AMA license (CLAUDE.md rule 11). */
export const codeSets = pgTable(
  'code_sets',
  {
    id: id(),
    /** icd10 | cpt_code_only | hcpcs | modifier | pos | carc | rarc | claim_status */
    type: text('type').notNull(),
    code: text('code').notNull(),
    shortLabel: text('short_label'),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    ...timestamps,
  },
  (t) => [unique('code_sets_type_code_from_key').on(t.type, t.code, t.effectiveFrom)],
);

export const ncciEdits = pgTable(
  'ncci_edits',
  {
    id: id(),
    column1Code: text('column1_code').notNull(),
    column2Code: text('column2_code').notNull(),
    /** 0 never allowed, 1 allowed with a modifier, 9 not applicable */
    modifierIndicator: text('modifier_indicator').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    ...timestamps,
  },
  (t) => [index('ncci_edits_pair_idx').on(t.column1Code, t.column2Code)],
);

/** Medically unlikely edits: the most units of a code billable per day (CMS MUE tables). */
export const mueLimits = pgTable(
  'mue_limits',
  {
    id: id(),
    code: text('code').notNull(),
    maxUnits: integer('max_units').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    ...timestamps,
  },
  (t) => [unique('mue_limits_code_from_key').on(t.code, t.effectiveFrom)],
);
