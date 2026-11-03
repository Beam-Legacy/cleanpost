/** PM connections and sync (docs/05-adapters.md). Credentials live in the secrets manager; only references here. */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { clientId, id, tenantId, timestamps } from './_columns';
import { clients } from './organization';

export const connections = pgTable(
  'connections',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    adapterKey: text('adapter_key').notNull(),
    /** Operation -> 0-4 or 'unavailable' (CapabilityMap). */
    levels: jsonb('levels').notNull().default({}),
    credentialsSecretRef: text('credentials_secret_ref'),
    pmAccountRef: text('pm_account_ref'),
    syncIntervalMinutes: integer('sync_interval_minutes'),
    /** Non-secret adapter settings, e.g. Tebra practice ID. */
    settings: jsonb('settings').notNull().default({}),
    /** setup | testing | healthy | degraded | failed | paused */
    status: text('status').notNull().default('setup'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Sync cycles in a row in which every operation failed (3 -> failed, docs/03-state-machines.md). */
    consecutiveFailedCycles: integer('consecutive_failed_cycles').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    credentialsRotatedAt: timestamp('credentials_rotated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('connections_client_idx').on(t.clientId),
    check(
      'connections_status_check',
      sql`${t.status} in ('setup', 'testing', 'healthy', 'degraded', 'failed', 'paused')`,
    ),
  ],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    operation: text('operation').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`app.now()`),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** running | succeeded | failed */
    status: text('status').notNull().default('running'),
    /** { new, changed, unchanged, failed } */
    counts: jsonb('counts').notNull().default({}),
    errorCode: text('error_code'),
    /** Plain language, never PHI or raw payloads. */
    errorDetail: text('error_detail'),
    ...timestamps,
  },
  (t) => [index('sync_runs_connection_idx').on(t.connectionId, t.startedAt)],
);

export const externalRefs = pgTable(
  'external_refs',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: clientId().references(() => clients.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    externalId: text('external_id').notNull(),
    ...timestamps,
  },
  (t) => [unique('external_refs_key').on(t.connectionId, t.entityType, t.externalId)],
);

export const manualTasks = pgTable('manual_tasks', {
  id: id(),
  tenantId: tenantId(),
  clientId: clientId().references(() => clients.id),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id),
  operation: text('operation').notNull(),
  workItemId: uuid('work_item_id'),
  title: text('title').notNull(),
  instructions: text('instructions')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  payloadRef: text('payload_ref'),
  /** open | done | failed */
  status: text('status').notNull().default('open'),
  pmReference: text('pm_reference'),
  ...timestamps,
});

/**
 * Token buckets for PM rate limits (docs/05-adapters.md), shared by every worker: one row per PM
 * account (pm_account_ref, or the connection when it has none) and PM endpoint.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    id: id(),
    tenantId: tenantId(),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    refilledAt: timestamp('refilled_at', { withTimezone: true })
      .notNull()
      .default(sql`app.now()`),
    ...timestamps,
  },
  (t) => [unique('rate_limit_buckets_key').on(t.tenantId, t.key, t.endpoint)],
);
