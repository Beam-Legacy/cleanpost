/** A practice's setup: payers, providers and locations. */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { clientId, id, tenantId, timestamps } from './_columns';
import { clients } from './organization';
import { payers } from './reference';

export const clientPayerSettings = pgTable(
  'client_payer_settings',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    payerId: uuid('payer_id')
      .notNull()
      .references(() => payers.id),
    modeOverride: text('mode_override'),
    autoReleaseThresholdOverride: smallint('auto_release_threshold_override'),
    /** not_required | not_started | pending | active | rejected */
    eraEnrollmentStatus: text('era_enrollment_status').notNull().default('not_started'),
    ediEnrollmentStatus: text('edi_enrollment_status').notNull().default('not_started'),
    timelyFilingDays: integer('timely_filing_days').notNull().default(90),
    /** Name the PM uses for this payer, for mapping (O-06). */
    pmPayerName: text('pm_payer_name'),
    ...timestamps,
  },
  (t) => [
    unique('client_payer_settings_client_payer_key').on(t.clientId, t.payerId),
    check(
      'client_payer_settings_mode_check',
      sql`${t.modeOverride} is null or ${t.modeOverride} in ('A', 'B', 'C')`,
    ),
  ],
);

export const providers = pgTable(
  'providers',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    npi: text('npi').notNull(),
    name: text('name').notNull(),
    taxonomy: text('taxonomy'),
    /** rendering | billing | referring */
    role: text('role').notNull().default('rendering'),
    ...timestamps,
  },
  (t) => [
    unique('providers_client_npi_key').on(t.clientId, t.npi),
    index('providers_client_idx').on(t.clientId),
  ],
);

export const locations = pgTable(
  'locations',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    name: text('name').notNull(),
    address: jsonb('address'),
    placeOfService: text('place_of_service').notNull().default('11'),
    npi: text('npi'),
    ...timestamps,
  },
  (t) => [index('locations_client_idx').on(t.clientId)],
);
