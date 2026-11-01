/**
 * M0 acceptance: a cross-tenant read is blocked for every table.
 *
 * The first test inventories the live schema, so a new table fails here until it is either given
 * tenant RLS (app.enable_tenant_rls) and added to TENANT_TABLES, or listed as global on purpose.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createDatabase, withTenant, withUser, type DatabaseHandle } from '../src';
import { testDatabaseUrls } from '../src/testing';

const { adminUrl: TEST_DATABASE_ADMIN_URL, url: TEST_DATABASE_URL } = testDatabaseUrls();

/** Tables with no tenant on purpose: identity and auth (docs/02-data-model.md). */
const GLOBAL_TABLES = ['accounts', 'passkeys', 'sessions', 'two_factors', 'users', 'verifications'];

/** Every tenant table and the column its policy checks. */
const TENANT_TABLES: Record<string, 'tenant_id' | 'id'> = {
  tenants: 'id',
  memberships: 'tenant_id',
  clients: 'tenant_id',
  user_preferences: 'tenant_id',
  audit_events: 'tenant_id',
};

const A = { tenant: uuidv7(), user: uuidv7(), client: uuidv7() };
const B = { tenant: uuidv7(), user: uuidv7(), client: uuidv7() };

let admin: DatabaseHandle;
let app: DatabaseHandle;

beforeAll(async () => {
  admin = createDatabase(TEST_DATABASE_ADMIN_URL, { max: 1 });
  app = createDatabase(TEST_DATABASE_URL, { max: 2 });
  for (const [t, label] of [
    [A, 'Northwind Billing'],
    [B, 'Harbor RCM'],
  ] as const) {
    const statements = [
      sql`insert into users (id, name, email) values (${t.user}, ${'User ' + label}, ${t.user + '@example.test'})`,
      sql`insert into tenants (id, name) values (${t.tenant}, ${label})`,
      sql`insert into memberships (tenant_id, user_id, role, is_owner) values (${t.tenant}, ${t.user}, 'admin', true)`,
      sql`insert into clients (id, tenant_id, name) values (${t.client}, ${t.tenant}, ${'Client of ' + label})`,
      sql`insert into user_preferences (tenant_id, user_id) values (${t.tenant}, ${t.user})`,
      sql`insert into audit_events (tenant_id, actor, action, entity_type, entity_id)
          values (${t.tenant}, ${'user:' + t.user}, 'client.created', 'client', ${t.client})`,
    ];
    for (const statement of statements) await admin.db.execute(statement);
  }
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
      const res = await app.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(res.rows[0]!.n).toBe(0);
    });

    it(`${table}: cannot update or delete another tenant's rows`, async () => {
      if (table === 'audit_events') return; // append-only; covered below
      const affected = await withTenant(app.db, { tenantId: A.tenant, userId: A.user }, async (tx) => {
        const upd = await tx.execute(
          sql.raw(`update ${table} set updated_at = now() where ${column} = '${B.tenant}'`),
        );
        const del =
          table === 'tenants'
            ? { rowCount: 0 } // apps have no DELETE on tenants at all
            : await tx.execute(sql.raw(`delete from ${table} where ${column} = '${B.tenant}'`));
        return (upd.rowCount ?? 0) + (del.rowCount ?? 0);
      });
      expect(affected).toBe(0);
    });
  }

  it('rejects inserting rows into another tenant', async () => {
    const attempts = [
      sql`insert into clients (tenant_id, name) values (${B.tenant}, 'Injected')`,
      sql`insert into memberships (tenant_id, user_id, role) values (${B.tenant}, ${A.user}, 'admin')`,
      sql`insert into user_preferences (tenant_id, user_id) values (${B.tenant}, ${A.user})`,
      sql`insert into audit_events (tenant_id, actor, action, entity_type) values (${B.tenant}, 'system', 'x', 'y')`,
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
