import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuid } from 'uuid';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { endMemberSessions, resetMemberTwoFactor, setMemberStatus, updateMemberAccess } from '../src';

/**
 * S-03 (docs/03 Membership, DEC-22): role and clients, deactivate and reactivate, sign out
 * everywhere and reset two-factor, all inside the admin's company. The owner and the admin's own
 * membership are not edited; a person in two companies keeps their sign-in in the other one.
 */
const { adminUrl, url } = testDatabaseUrls();
let app: DatabaseHandle;
let admin: DatabaseHandle;
const T = uuid();
const OTHER = uuid();
const ADMIN = uuid();
const OWNER = uuid();
const BILLER = uuid();
const BOTH = uuid();
const C1 = uuid();
const C2 = uuid();
const X = uuid();
const M = { admin: uuid(), owner: uuid(), biller: uuid(), both: uuid() };
const NOW = new Date('2026-11-04T17:00:00Z');
const ctx = () => ({ tenantId: T, userId: ADMIN });

const session = (userId: string, tenantId: string | null) =>
  admin.db.execute(sql`insert into sessions (id, token, expires_at, user_id, active_tenant_id)
    values (${uuid()}, ${uuid()}, now() + interval '1 hour', ${userId}, ${tenantId})`);
const sessionsOf = async (userId: string) =>
  (
    await admin.db.execute<{ active_tenant_id: string | null }>(
      sql`select active_tenant_id from sessions where user_id = ${userId} order by active_tenant_id`,
    )
  ).rows.map((r) => r.active_tenant_id);
const member = async (id: string) =>
  (
    await admin.db.execute<{ role: string; client_scope: string; client_ids: string[]; status: string }>(
      sql`select role, client_scope, client_ids, status from memberships where id = ${id}`,
    )
  ).rows[0];
const actions = async () =>
  (
    await admin.db.execute<{ action: string }>(
      sql`select action from audit_events where tenant_id = ${T} and entity_type = 'membership' order by at, id`,
    )
  ).rows.map((r) => r.action);

beforeAll(async () => {
  app = createDatabase(url, { max: 3 });
  admin = createDatabase(adminUrl, { max: 1 });
  await admin.db.execute(
    sql`insert into tenants (id, name) values (${T}, 'Members Billing'), (${OTHER}, 'Elsewhere RCM')`,
  );
  await admin.db.execute(sql`insert into clients (id, tenant_id, name) values
    (${C1}, ${T}, 'Client One'), (${C2}, ${T}, 'Client Two'), (${X}, ${OTHER}, 'Their Client')`);
  for (const [id, name] of [
    [ADMIN, 'Priya Admin'],
    [OWNER, 'Julia Owner'],
    [BILLER, 'Dana Biller'],
    [BOTH, 'Hana Both'],
  ] as const)
    await admin.db.execute(
      sql`insert into users (id, name, email, two_factor_enabled) values (${id}, ${name}, ${`${id}@members.test`}, true)`,
    );
  await admin.db
    .execute(sql`insert into memberships (id, tenant_id, user_id, role, is_owner, client_scope, client_ids) values
    (${M.admin}, ${T}, ${ADMIN}, 'admin', false, 'all', '{}'),
    (${M.owner}, ${T}, ${OWNER}, 'admin', true, 'all', '{}'),
    (${M.biller}, ${T}, ${BILLER}, 'biller', false, 'list', ${`{${C1},${C2}}`}),
    (${M.both}, ${T}, ${BOTH}, 'viewer', false, 'list', ${`{${C1}}`}),
    (${uuid()}, ${OTHER}, ${BOTH}, 'biller', false, 'all', '{}')`);
  for (const u of [BILLER, BOTH])
    await admin.db.execute(
      sql`insert into two_factors (id, secret, backup_codes, user_id) values (${uuid()}, 's', 'c', ${u})`,
    );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('S-03 edit user', () => {
  it('changes role and clients, audits each, and says which clients they keep', async () => {
    expect(
      await updateMemberAccess(app.db, ctx(), M.biller, { role: 'viewer', clientIds: [C1] }, NOW),
    ).toEqual({ ok: true, userId: BILLER, keep: [C1], changed: true });
    expect(await member(M.biller)).toMatchObject({ role: 'viewer', client_scope: 'list', client_ids: [C1] });
    expect(await actions()).toEqual(['user.role_changed', 'user.clients_changed']);
    expect(
      await updateMemberAccess(app.db, ctx(), M.biller, { role: 'viewer', clientIds: [C1] }, NOW),
    ).toMatchObject({ ok: true, changed: false });
    expect(
      await updateMemberAccess(app.db, ctx(), M.biller, { role: 'biller', clientIds: [C1, C2] }, NOW),
    ).toMatchObject({ ok: true, keep: [C1, C2].sort(), changed: true });
    expect(
      await updateMemberAccess(app.db, ctx(), M.biller, { role: 'admin', clientIds: [C1] }, NOW),
    ).toMatchObject({ ok: true, keep: 'all' });
    expect(await member(M.biller)).toMatchObject({ role: 'admin', client_scope: 'all', client_ids: [] });
    await updateMemberAccess(app.db, ctx(), M.biller, { role: 'biller', clientIds: [C1, C2] }, NOW);
  });

  it('refuses the owner, your own membership, no clients, and clients of another company', async () => {
    const res = (id: string, clientIds: string[]) =>
      updateMemberAccess(app.db, ctx(), id, { role: 'biller', clientIds }, NOW);
    expect(await res(M.owner, [C1])).toEqual({ ok: false, reason: 'owner' });
    expect(await res(M.admin, [C1])).toEqual({ ok: false, reason: 'self' });
    expect(await res(M.biller, [])).toEqual({ ok: false, reason: 'clients_required' });
    expect(await res(M.biller, [C1, X])).toEqual({ ok: false, reason: 'unknown_client' });
    expect(await setMemberStatus(app.db, ctx(), M.owner, 'deactivate', NOW)).toEqual({
      ok: false,
      reason: 'owner',
    });
    expect(await endMemberSessions(app.db, ctx(), M.admin)).toEqual({ ok: false, reason: 'self' });
  });

  it('deactivating ends their sessions in this company at once; reactivating brings them back', async () => {
    await session(BOTH, T);
    await session(BOTH, OTHER);
    await session(BOTH, null);
    expect(await setMemberStatus(app.db, ctx(), M.both, 'deactivate', NOW)).toEqual({
      ok: true,
      userId: BOTH,
    });
    expect(await member(M.both)).toMatchObject({ status: 'deactivated' });
    expect(await sessionsOf(BOTH)).toEqual([OTHER, null]);
    expect(await setMemberStatus(app.db, ctx(), M.both, 'deactivate', NOW)).toEqual({
      ok: false,
      reason: 'invalid_state',
    });
    expect(await setMemberStatus(app.db, ctx(), M.both, 'reactivate', NOW)).toMatchObject({ ok: true });
    expect(await member(M.both)).toMatchObject({ status: 'active' });
  });

  it('sign out everywhere ends only sessions with this company open', async () => {
    await session(BILLER, T);
    await session(BILLER, T);
    expect(await endMemberSessions(app.db, ctx(), M.biller)).toEqual({ ok: true, ended: 2 });
    expect(await endMemberSessions(app.db, ctx(), M.both)).toEqual({ ok: true, ended: 0 });
    expect(await sessionsOf(BOTH)).toEqual([OTHER, null]);
  });

  it('resets two-factor for someone who works only here, not for someone in another company', async () => {
    await session(BILLER, null);
    expect(await resetMemberTwoFactor(app.db, ctx(), M.biller)).toEqual({ ok: true });
    const [u] = (
      await admin.db.execute<{ two_factor_enabled: boolean; factors: number }>(sql`
        select two_factor_enabled, (select count(*)::int from two_factors where user_id = ${BILLER}) as factors
        from users where id = ${BILLER}`)
    ).rows;
    expect(u).toEqual({ two_factor_enabled: false, factors: 0 });
    expect(await sessionsOf(BILLER)).toEqual([]);
    expect(await resetMemberTwoFactor(app.db, ctx(), M.both)).toEqual({ ok: false, reason: 'other_company' });
    expect(await actions()).toContain('user.two_factor_reset');
  });

  it('another company cannot reach these memberships', async () => {
    const theirs = { tenantId: OTHER, userId: ADMIN };
    expect(await setMemberStatus(app.db, theirs, M.biller, 'deactivate', NOW)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await resetMemberTwoFactor(app.db, theirs, M.biller)).toEqual({ ok: false, reason: 'not_found' });
    // app.member_elsewhere answers only for members of the caller's own company.
    const elsewhere = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${OTHER}, true)`);
      return (await tx.execute<{ e: boolean }>(sql`select app.member_elsewhere(${BILLER}::uuid) as e`))
        .rows[0]!.e;
    });
    expect(elsewhere).toBe(false);
  });
});
