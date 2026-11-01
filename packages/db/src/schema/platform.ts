/** Platform records: agreements, exports, invoices, requests, break-glass, banners, usage, webhooks. */
import { date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { cents, id, tenantId, timestamps } from './_columns';
import { users } from './auth';
import { clients } from './organization';

export const tenantAgreements = pgTable('tenant_agreements', {
  id: id(),
  tenantId: tenantId(),
  /** baa | customer_agreement */
  type: text('type').notNull(),
  version: text('version').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  storageKey: text('storage_key'),
  ...timestamps,
});

export const dataExports = pgTable('exports', {
  id: id(),
  tenantId: tenantId(),
  clientId: uuid('client_id').references(() => clients.id),
  /** report_pdf | report_csv | claims_csv | audit_csv | offboarding */
  type: text('type').notNull(),
  requestedBy: uuid('requested_by').references(() => users.id),
  /** queued | ready | expired | failed */
  status: text('status').notNull().default('queued'),
  storageKey: text('storage_key'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  ...timestamps,
});

export const invoices = pgTable('invoices', {
  id: id(),
  tenantId: tenantId(),
  number: text('number').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  amountCents: cents('amount_cents').notNull(),
  status: text('status').notNull().default('draft'),
  providerRef: text('provider_ref'),
  dueAt: date('due_at'),
  ...timestamps,
});

export const integrationRequests = pgTable('integration_requests', {
  id: id(),
  tenantId: tenantId(),
  pmName: text('pm_name').notNull(),
  clientIds: uuid('client_ids').array().notNull().default([]),
  operations: text('operations').array().notNull().default([]),
  monthlyVolumeEstimate: integer('monthly_volume_estimate'),
  createdBy: uuid('created_by').references(() => users.id),
  status: text('status').notNull().default('open'),
  ...timestamps,
});

export const breakGlassGrants = pgTable('break_glass_grants', {
  id: id(),
  tenantId: tenantId(),
  operatorUserId: uuid('operator_user_id').notNull(),
  reason: text('reason').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
});

/** Global (no tenant). G-13. */
export const platformBanners = pgTable('platform_banners', {
  id: id(),
  type: text('type').notNull(),
  message: text('message').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  affected: jsonb('affected').notNull().default({}),
  link: text('link'),
  ...timestamps,
});

export const usageRecords = pgTable(
  'usage_records',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    date: date('date').notNull(),
    claimsReleased: integer('claims_released').notNull().default(0),
    claimsByMode: jsonb('claims_by_mode').notNull().default({}),
    ...timestamps,
  },
  (t) => [unique('usage_records_client_date_key').on(t.clientId, t.date)],
);

/** Global (no tenant): webhooks arrive before a tenant is known. IDs only, never payloads. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** received | processed | failed | ignored */
    status: text('status').notNull().default('received'),
    ...timestamps,
  },
  (t) => [
    unique('webhook_events_source_external_key').on(t.source, t.externalId),
    index('webhook_events_status_idx').on(t.status),
  ],
);
