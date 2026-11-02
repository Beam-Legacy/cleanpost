/**
 * Acceptance (M0, extended in M1): a cross-tenant read is blocked for every table.
 *
 * The first test inventories the live schema, so a new table fails here until it is either given
 * tenant RLS (app.enable_tenant_rls), added to TENANT_TABLES and to the fixture, or listed as
 * global on purpose.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createDatabase, payers, rules, withTenant, withUser, type DatabaseHandle } from '../src';
import { testDatabaseUrls } from '../src/testing';
import { insertTenantFixture, newFixture } from './fixtures';

const { adminUrl: TEST_DATABASE_ADMIN_URL, url: TEST_DATABASE_URL } = testDatabaseUrls();

/** Tables with no tenant on purpose: identity, auth and reference data (docs/02-data-model.md). */
const GLOBAL_TABLES = [
  'accounts',
  'code_sets',
  'mue_limits',
  'ncci_edits',
  'passkeys',
  'payers',
  'platform_banners',
  'sessions',
  'two_factors',
  'users',
  'verifications',
  'webhook_events',
];

/** Every tenant table and the column its policy checks. */
const TENANT_TABLES: Record<string, 'tenant_id' | 'id'> = {
  tenants: 'id',
  ...Object.fromEntries(
    [
      'memberships',
      'clients',
      'user_preferences',
      'audit_events',
      'client_payer_settings',
      'providers',
      'locations',
      'patients',
      'coverages',
      'eligibility_checks',
      'documents',
      'encounters',
      'charge_lines',
      'diagnoses',
      'claims',
      'claim_versions',
      'claim_lines',
      'scrub_results',
      'claim_events',
      'remittances',
      'remit_claims',
      'remit_lines',
      'remit_adjustments',
      'remit_remarks',
      'provider_adjustments',
      'adjustment_mappings',
      'postings',
      'pm_postings',
      'work_items',
      'corrections',
      'write_off_requests',
      'rules',
      'saved_views',
      'notification_rules',
      'notifications',
      'connections',
      'sync_runs',
      'rate_limit_buckets',
      'external_refs',
      'manual_tasks',
      'tenant_agreements',
      'exports',
      'invoices',
      'integration_requests',
      'break_glass_grants',
      'usage_records',
    ].map((t) => [t, 'tenant_id' as const]),
  ),
};

/** Never deleted (docs/02-data-model.md): the app role has no DELETE on these at all. */
const NEVER_DELETED = new Set([
  'tenants',
  'claims',
  'claim_versions',
  'claim_lines',
  'claim_events',
  'scrub_results',
  'remittances',
  'remit_claims',
  'remit_lines',
  'remit_adjustments',
  'remit_remarks',
  'provider_adjustments',
]);

const A = newFixture();
const B = newFixture();
let aClaimVersionId = '';

let admin: DatabaseHandle;
let app: DatabaseHandle;

beforeAll(async () => {
  admin = createDatabase(TEST_DATABASE_ADMIN_URL, { max: 1 });
  app = createDatabase(TEST_DATABASE_URL, { max: 2 });
  const [payer] = await admin.db.insert(payers).values({ name: 'Aetna' }).returning();
  ({ claimVersionId: aClaimVersionId } = await insertTenantFixture(
    admin.db,
    A,
    'Northwind Billing',
    payer!.id,
  ));
  await insertTenantFixture(admin.db, B, 'Harbor RCM', payer!.id);
  await admin.db.insert(rules).values({
    scope: 'global',
    name: 'Global rule',
    kind: 'validate',
    condition: {},
    action: {},
    severity: 'block',
    source: 'seed',
  });
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('schema inventory', () => {
  it('gives every table either tenant RLS or an explicit global listing', async () => {
    const { rows } = await admin.pool.query<{
      table: string;
      has_tenant: boolean;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(`
      select c.relname as table,
             exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = c.relname and column_name = 'tenant_id') as has_tenant,
             c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);

    const tenantTables = rows.filter((r) => !GLOBAL_TABLES.includes(r.table));
    expect(tenantTables.map((r) => r.table).sort()).toEqual(Object.keys(TENANT_TABLES).sort());
    for (const r of tenantTables) {
      expect({ table: r.table, rls: r.rls, forced: r.forced }).toEqual({
        table: r.table,
        rls: true,
        forced: true,
      });
      expect(r.policies, r.table).toBeGreaterThan(0);
      if (r.table !== 'tenants') expect(r.has_tenant, r.table).toBe(true);
    }
    for (const g of GLOBAL_TABLES) {
      const row = rows.find((r) => r.table === g);
      expect(row, g).toBeDefined();
      expect(row!.has_tenant, g).toBe(false);
    }
  });

  it('connects the app as a role that cannot bypass RLS', async () => {
    const { rows } = await app.pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'select rolbypassrls, rolsuper from pg_roles where rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe('cross-tenant access is blocked', () => {
  for (const [table, column] of Object.entries(TENANT_TABLES)) {
    it(`${table}: reads only the current tenant's rows`, async () => {
      const counts = await withTenant(app.db, { tenantId: A.tenant, userId: A.user }, async (tx) => {
        const res = await tx.execute<{ own: number; other: number }>(
          sql.raw(`select count(*) filter (where ${column} = '${A.tenant}')::int as own,
                          count(*) filter (where ${column} <> '${A.tenant}')::int as other
                   from ${table}`),
        );
        return res.rows[0]!;
      });
      expect(counts.own).toBeGreaterThan(0);
      expect(counts.other).toBe(0);
    });

    it(`${table}: returns nothing when no tenant is set`, async () => {
      // Global seed rules (tenant_id null) are readable by design; no tenant's rows may show.
      const where = table === 'rules' ? ' where tenant_id is not null' : '';
      const res = await app.pool.query<{ n: number }>(`select count(*)::int as n from ${table}${where}`);
      expect(res.rows[0]!.n).toBe(0);
    });

    it(`${table}: cannot update or delete another tenant's rows`, async () => {
      if (table === 'audit_events') return; // append-only; covered below
      const updated = await withTenant(app.db, { tenantId: A.tenant, userId: A.user }, async (tx) => {
        const upd = await tx.execute(
          sql.raw(`update ${table} set updated_at = now() where ${column} = '${B.tenant}'`),
        );
        return upd.rowCount ?? 0;
      });
      expect(updated).toBe(0);
      if (NEVER_DELETED.has(table)) {
        // No DELETE privilege at all, not even on the tenant's own rows.
        await expect(
          withTenant(app.db, { tenantId: A.tenant }, (tx) =>
            tx.execute(sql.raw(`delete from ${table} where ${column} = '${A.tenant}'`)),
          ),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      } else {
        const deleted = await withTenant(app.db, { tenantId: A.tenant, userId: A.user }, async (tx) => {
          const del = await tx.execute(sql.raw(`delete from ${table} where ${column} = '${B.tenant}'`));
          return del.rowCount ?? 0;
        });
        expect(deleted).toBe(0);
      }
    });
  }

  it('rejects inserting rows into another tenant', async () => {
    const attempts = [
      sql`insert into clients (tenant_id, name) values (${B.tenant}, 'Injected')`,
      sql`insert into memberships (tenant_id, user_id, role) values (${B.tenant}, ${A.user}, 'admin')`,
      sql`insert into user_preferences (tenant_id, user_id) values (${B.tenant}, ${A.user})`,
      sql`insert into audit_events (tenant_id, actor, action, entity_type) values (${B.tenant}, 'system', 'x', 'y')`,
      sql`insert into work_items (tenant_id, type, due_at, reason_code, summary) values (${B.tenant}, 'system', now(), 'x', 'x')`,
      sql`insert into rules (tenant_id, scope, name, kind, condition, action, severity, source)
          values (null, 'global', 'Injected', 'validate', '{}', '{}', 'block', 'user')`,
      sql`insert into tenants (id, name) values (${uuidv7()}, 'Injected')`,
    ];
    for (const attempt of attempts) {
      await expect(
        withTenant(app.db, { tenantId: A.tenant, userId: A.user }, (tx) => tx.execute(attempt)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('refuses to turn row security off for the app role', async () => {
    await expect(
      withTenant(app.db, { tenantId: A.tenant }, async (tx) => {
        await tx.execute(sql`set local row_security = off`);
        return tx.execute(sql`select * from clients`);
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects a tenant context that is not a UUID', async () => {
    await expect(withTenant(app.db, { tenantId: "x' or '1'='1" }, async () => 1)).rejects.toThrow('UUID');
  });
});

describe('before a company is chosen', () => {
  it("shows a user only their own memberships and those tenants' names", async () => {
    const seen = await withUser(app.db, A.user, async (tx) => ({
      memberships: (await tx.execute<{ tenant_id: string }>(sql`select tenant_id from memberships`)).rows,
      tenants: (await tx.execute<{ name: string }>(sql`select name from tenants`)).rows,
      clients: (await tx.execute(sql`select id from clients`)).rows,
    }));
    expect(seen.memberships).toEqual([{ tenant_id: A.tenant }]);
    expect(seen.tenants).toEqual([{ name: 'Northwind Billing' }]);
    expect(seen.clients).toEqual([]);
  });
});

describe('audit_events', () => {
  it('is append-only for the app and the owner', async () => {
    await expect(
      withTenant(app.db, { tenantId: A.tenant }, (tx) =>
        tx.execute(sql`update audit_events set action = 'x'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(admin.db.execute(sql`delete from audit_events`)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });
});

describe('rules', () => {
  it('shows global rules to every tenant but lets none change them', async () => {
    const seen = await withTenant(app.db, { tenantId: A.tenant }, async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from rules where tenant_id is null`,
      );
      const u = await tx.execute(sql`update rules set enabled = false where tenant_id is null`);
      return { globals: r.rows[0]!.n, updated: u.rowCount };
    });
    expect(seen).toEqual({ globals: 1, updated: 0 });
  });
});

describe('sync scheduler', () => {
  it('lists due-able connections across tenants with schedule fields only', async () => {
    await admin.db.execute(
      sql`update connections set status = 'healthy' where tenant_id in (${A.tenant}, ${B.tenant})`,
    );
    const res = await app.pool.query<Record<string, unknown>>('select * from app.sync_candidates()');
    expect(new Set(res.rows.map((r) => r.tenant_id))).toEqual(new Set([A.tenant, B.tenant]));
    expect(Object.keys(res.rows[0]!).sort()).toEqual(
      [
        'adapter_key',
        'connection_id',
        'last_success_at',
        'next_run_at',
        'status',
        'sync_interval_minutes',
        'tenant_id',
      ].sort(),
    );
    // Still no direct cross-tenant read of the table itself.
    const direct = await app.pool.query<{ n: number }>('select count(*)::int as n from connections');
    expect(direct.rows[0]!.n).toBe(0);
  });

  it('skips paused, failed and setup connections', async () => {
    await admin.db.execute(sql`update connections set status = 'paused' where tenant_id = ${B.tenant}`);
    const res = await app.pool.query<{ tenant_id: string }>('select tenant_id from app.sync_candidates()');
    expect(res.rows.map((r) => r.tenant_id)).toEqual([A.tenant]);
  });
});

describe('claim versions', () => {
  it('cannot change once released, even for the owner', async () => {
    await admin.db.execute(sql`update claim_versions set released_at = now() where id = ${aClaimVersionId}`);
    await expect(
      admin.db.execute(sql`update claim_versions set payload = '{}' where id = ${aClaimVersionId}`),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      admin.db.execute(sql`update claim_lines set units = 2 where claim_version_id = ${aClaimVersionId}`),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
