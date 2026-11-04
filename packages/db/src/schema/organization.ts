import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, tenantId, timestamps } from './_columns';
import { users } from './auth';

/** A billing company. RLS: the current tenant, plus tenants the current user belongs to (A-07). */
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  address: jsonb('address'),
  phone: text('phone'),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  plan: text('plan').notNull().default('pilot'),
  /** active | suspended | closed */
  status: text('status').notNull().default('active'),
  billingEmail: text('billing_email'),
  securityContact: jsonb('security_contact'),
  billingContact: jsonb('billing_contact'),
  settings: jsonb('settings').notNull().default({}),
  ...timestamps,
});

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** admin | biller | viewer */
    role: text('role').notNull(),
    isOwner: boolean('is_owner').notNull().default(false),
    /** all | list; with list, clientIds holds the clients this member can see */
    clientScope: text('client_scope').notNull().default('all'),
    clientIds: uuid('client_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** active | invited | deactivated */
    status: text('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    unique('memberships_tenant_user_key').on(t.tenantId, t.userId),
    index('memberships_user_id_idx').on(t.userId),
    check('memberships_role_check', sql`${t.role} in ('admin', 'biller', 'viewer')`),
    check('memberships_client_scope_check', sql`${t.clientScope} in ('all', 'list')`),
  ],
);

/**
 * S-02 / A-06: an invite to join the company. The token is sent once by email (E-01) and only its
 * SHA-256 is stored; it works once and for 7 days. The person accepting is not signed in, so the
 * accept page reads it through app.invitation_by_token (by hash only), never the table.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    /** Lowercased. */
    email: text('email').notNull(),
    role: text('role').notNull(),
    clientScope: text('client_scope').notNull().default('all'),
    clientIds: uuid('client_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    /** pending | accepted | revoked (an expired invite is pending past expires_at) */
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index('invitations_tenant_email_idx').on(t.tenantId, t.email),
    check('invitations_role_check', sql`${t.role} in ('admin', 'biller', 'viewer')`),
    check('invitations_client_scope_check', sql`${t.clientScope} in ('all', 'list')`),
    check('invitations_status_check', sql`${t.status} in ('pending', 'accepted', 'revoked')`),
  ],
);

/** A practice the billing company serves. M0 holds the fields the shell and policy need; M1 adds the rest. */
export const clients = pgTable(
  'clients',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    name: text('name').notNull(),
    /** Field-encrypted (see src/crypto.ts); never stored or logged in plain text. */
    taxIdEncrypted: text('tax_id_encrypted'),
    address: jsonb('address'),
    billingNpi: text('billing_npi'),
    taxonomy: text('taxonomy'),
    timezone: text('timezone').notNull().default('America/Los_Angeles'),
    /** onboarding | live | paused | offboarded */
    status: text('status').notNull().default('onboarding'),
    defaultMode: text('default_mode').notNull().default('A'),
    /** S-04: null follows the company default (tenants.settings.autoReleaseThreshold); 100 = review everything. */
    autoReleaseThreshold: smallint('auto_release_threshold'),
    pmBatchTime: time('pm_batch_time'),
    goLiveAt: timestamp('go_live_at', { withTimezone: true }),
    offboardedAt: timestamp('offboarded_at', { withTimezone: true }),
    /** CL-02 / O-10: the practice's figures before Cleanpost (domain ClientBaseline); totals only. */
    baseline: jsonb('baseline'),
    /** CL-08 while paused: { reason, note, resumeOn, pausedAt, pausedBy }; null when not paused. */
    pause: jsonb('pause'),
    ...timestamps,
  },
  (t) => [
    index('clients_tenant_id_idx').on(t.tenantId),
    check('clients_status_check', sql`${t.status} in ('onboarding', 'live', 'paused', 'offboarded')`),
    check('clients_mode_check', sql`${t.defaultMode} in ('A', 'B', 'C')`),
    check('clients_threshold_check', sql`${t.autoReleaseThreshold} between 0 and 100`),
  ],
);

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    density: text('density').notNull().default('compact'),
    theme: text('theme').notNull().default('system'),
    digestTime: time('digest_time'),
    quietHours: jsonb('quiet_hours'),
    shortcutOverrides: jsonb('shortcut_overrides').notNull().default({}),
    checklist: jsonb('checklist').notNull().default({}),
    ...timestamps,
  },
  (t) => [unique('user_preferences_tenant_user_key').on(t.tenantId, t.userId)],
);

/** Append-only. PHI reads are recorded too. No PHI in metadata. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    tenantId: tenantId().references(() => tenants.id),
    /** user:<id> | automation:<rule> | system | operator:<id> */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    clientId: uuid('client_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`app.now()`),
  },
  (t) => [
    index('audit_events_tenant_at_idx').on(t.tenantId, t.at),
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
  ],
);
