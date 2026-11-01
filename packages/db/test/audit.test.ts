import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  AuditEventError,
  auditEvents,
  clients,
  createDatabase,
  recordAudit,
  withAudit,
  withTenant,
  type DatabaseHandle,
} from '../src';
import { testDatabaseUrls } from '../src/testing';

const { adminUrl: TEST_DATABASE_ADMIN_URL, url: TEST_DATABASE_URL } = testDatabaseUrls();

const tenantId = uuidv7();
const userId = uuidv7();
const clientId = uuidv7();
let admin: DatabaseHandle;
let app: DatabaseHandle;

beforeAll(async () => {
  admin = createDatabase(TEST_DATABASE_ADMIN_URL, { max: 1 });
  app = createDatabase(TEST_DATABASE_URL, { max: 2 });
  await admin.db.execute(sql`insert into tenants (id, name) values (${tenantId}, 'Audit Test Billing')`);
  await admin.db.execute(
    sql`insert into clients (id, tenant_id, name) values (${clientId}, ${tenantId}, 'Audit Client')`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

const ctx = { tenantId, userId };
const event = {
  actor: `user:${userId}`,
  action: 'client.viewed',
  entityType: 'client',
  entityId: clientId,
  clientId,
} as const;

describe('withAudit', () => {
  it('records the event in the same transaction, tenant taken from context', async () => {
    const name = await withTenant(app.db, ctx, (tx) =>
      withAudit(tx, event, async () => {
        const [row] = await tx.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
        return row?.name;
      }),
    );
    expect(name).toBe('Audit Client');
    const rows = await withTenant(app.db, ctx, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, clientId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, actor: `user:${userId}`, action: 'client.viewed' });
  });

  it('leaves no audit event when the work fails', async () => {
    const before = await countEvents();
    await expect(
      withTenant(app.db, ctx, (tx) =>
        withAudit(tx, { ...event, action: 'client.updated' }, async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await countEvents()).toBe(before);
  });

  it('rejects metadata that carries PHI keys', async () => {
    await expect(
      withTenant(app.db, ctx, (tx) =>
        recordAudit(tx, { ...event, metadata: { fields: ['dob'], patient: { lastName: 'x' } } }),
      ),
    ).rejects.toThrow(AuditEventError);
  });

  it('accepts field names as values', async () => {
    await withTenant(app.db, ctx, (tx) =>
      recordAudit(tx, { ...event, action: 'phi.revealed', metadata: { fields: ['dob', 'memberId'] } }),
    );
  });

  it('rejects malformed actors and actions', async () => {
    await expect(
      withTenant(app.db, ctx, (tx) => recordAudit(tx, { ...event, actor: 'someone' as never })),
    ).rejects.toThrow('invalid actor');
    await expect(
      withTenant(app.db, ctx, (tx) => recordAudit(tx, { ...event, action: 'Viewed Client' })),
    ).rejects.toThrow('invalid action');
  });

  it('cannot write without a tenant context', async () => {
    await expect(app.db.transaction((tx) => recordAudit(tx, event))).rejects.toBeDefined();
  });
});

async function countEvents() {
  const r = await admin.pool.query<{ n: number }>(
    'select count(*)::int as n from audit_events where tenant_id = $1',
    [tenantId],
  );
  return r.rows[0]!.n;
}
