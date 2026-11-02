/** Work queue, corrections and rules (docs/08-work-queue.md, docs/06-rules-and-ai.md). */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, tenantId, timestamps } from './_columns';
import { users } from './auth';
import { clients } from './organization';

export const workItems = pgTable(
  'work_items',
  {
    id: id(),
    tenantId: tenantId(),
    clientId: uuid('client_id').references(() => clients.id),
    type: text('type').notNull(),
    /** open | assigned | in_progress | snoozed | resolved */
    status: text('status').notNull().default('open'),
    priority: smallint('priority').notNull().default(3),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id),
    claimId: uuid('claim_id'),
    remittanceId: uuid('remittance_id'),
    /** The payment in the 835 an unmatched-payment item is about (W-17). */
    remitClaimId: uuid('remit_claim_id'),
    encounterId: uuid('encounter_id'),
    documentId: uuid('document_id'),
    connectionId: uuid('connection_id'),
    reasonCode: text('reason_code').notNull(),
    /** One line, plain language, no PHI beyond what the UI shows. */
    summary: text('summary').notNull(),
    amountCents: integer('amount_cents'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolution: text('resolution'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('work_items_queue_idx').on(t.tenantId, t.status, t.priority, t.dueAt),
    index('work_items_assignee_idx').on(t.assigneeId, t.status),
    check('work_items_priority_check', sql`${t.priority} between 1 and 4`),
  ],
);

export const corrections = pgTable('corrections', {
  id: id(),
  tenantId: tenantId(),
  clientId: uuid('client_id').references(() => clients.id),
  workItemId: uuid('work_item_id').references(() => workItems.id),
  claimId: uuid('claim_id'),
  fieldPath: text('field_path').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  userId: uuid('user_id').references(() => users.id),
  promotedRuleId: uuid('promoted_rule_id'),
  ...timestamps,
});

/** tenant_id null = global rule (seed): readable by every tenant, writable by none (RLS migration). */
export const rules = pgTable(
  'rules',
  {
    id: id(),
    tenantId: uuid('tenant_id'),
    /** global | tenant | client | payer | client_payer */
    scope: text('scope').notNull(),
    /** Stable key for rules that come from files, e.g. "seed.coding.laterality"; null for user rules. */
    key: text('key'),
    clientId: uuid('client_id'),
    payerId: uuid('payer_id'),
    name: text('name').notNull(),
    /** validate | transform | route */
    kind: text('kind').notNull(),
    condition: jsonb('condition').notNull(),
    action: jsonb('action').notNull(),
    /** block | warn | info */
    severity: text('severity').notNull(),
    weight: smallint('weight').notNull().default(15),
    enabled: boolean('enabled').notNull().default(true),
    /** seed | user | promoted */
    source: text('source').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [index('rules_scope_idx').on(t.tenantId, t.scope, t.enabled)],
);

export const savedViews = pgTable('saved_views', {
  id: id(),
  tenantId: tenantId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  /** work | claims | remittances | denials */
  surface: text('surface').notNull(),
  name: text('name').notNull(),
  filters: jsonb('filters').notNull().default({}),
  sort: jsonb('sort').notNull().default({}),
  shared: boolean('shared').notNull().default(false),
  ...timestamps,
});

export const notificationRules = pgTable('notification_rules', {
  id: id(),
  tenantId: tenantId(),
  eventType: text('event_type').notNull(),
  channels: text('channels')
    .array()
    .notNull()
    .default(sql`'{in_app}'::text[]`),
  recipients: jsonb('recipients').notNull().default({}),
  thresholdCents: integer('threshold_cents'),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps,
});

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);
