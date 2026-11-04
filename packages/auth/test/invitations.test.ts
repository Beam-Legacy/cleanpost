import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuid } from 'uuid';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { memoryMailer } from '@cleanpost/email';
import {
  acceptInvitationAsNewUser,
  acceptInvitationAsUser,
  createAuth,
  createInvitations,
  createUserWithPassword,
  invitationByToken,
  resendInvitation,
  revokeInvitation,
  type Auth,
} from '../src';

/** S-02 / A-06 (docs/03 Invitation): invite, resend, revoke, expire, accept as new or existing user. */
const { adminUrl, url } = testDatabaseUrls();
let app: DatabaseHandle;
let admin: DatabaseHandle;
let auth: Auth;
const T = uuid();
const OTHER = uuid();
const ADMIN = uuid();
const CLIENT = uuid();
const NOW = new Date('2026-11-04T17:00:00Z');
const ctx = () => ({ tenantId: T, userId: ADMIN });
const PASSWORD = 'a long enough password';

beforeAll(async () => {
  app = createDatabase(url, { max: 3 });
  admin = createDatabase(adminUrl, { max: 1 });
  auth = createAuth({
    db: app.db,
    mailer: memoryMailer(),
    secret: 's'.repeat(32),
    appUrl: 'http://localhost:3000',
  });
  await admin.db.execute(
    sql`insert into tenants (id, name) values (${T}, 'Invite Billing'), (${OTHER}, 'Other Billing')`,
  );
  await admin.db.execute(
    sql`insert into clients (id, tenant_id, name) values (${CLIENT}, ${T}, 'Invite Client')`,
  );
  await admin.db.execute(
    sql`insert into users (id, name, email) values (${ADMIN}, 'Priya Admin', ${`${ADMIN}@invite.test`})`,
  );
  await admin.db.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${T}, ${ADMIN}, 'admin')`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

const membership = async (email: string) =>
  (
    await admin.db.execute<{ tenant_id: string; role: string; client_scope: string; status: string }>(sql`
      select m.tenant_id, m.role, m.client_scope, m.status from memberships m join users u on u.id = m.user_id
      where u.email = ${email} order by m.created_at`)
  ).rows;

describe('invitations', () => {
  it('invites by email, refuses members, live invites and bad addresses, and keeps only the token hash', async () => {
    const res = await createInvitations(
      app.db,
      ctx(),
      [' New.Biller@Invite.test ', 'new.biller@invite.test', `${ADMIN}@invite.test`, 'not-an-email'],
      { role: 'biller', clientIds: [CLIENT] },
      NOW,
    );
    expect(res.map((r) => [r.email, r.refused ?? 'invited'])).toEqual([
      ['new.biller@invite.test', 'invited'],
      [`${ADMIN}@invite.test`, 'already_member'],
      ['not-an-email', 'invalid_email'],
    ]);
    const token = res[0]!.invite!.token;
    const stored = await admin.db.execute<{ token_hash: string }>(
      sql`select token_hash from invitations where email = 'new.biller@invite.test'`,
    );
    expect(stored.rows[0]!.token_hash).not.toContain(token);
    expect(stored.rows[0]!.token_hash).toHaveLength(64);
    const again = await createInvitations(
      app.db,
      ctx(),
      ['new.biller@invite.test'],
      { role: 'viewer', clientIds: [CLIENT] },
      NOW,
    );
    expect(again[0]!.refused).toBe('already_invited');
    await expect(
      createInvitations(app.db, ctx(), ['x@invite.test'], { role: 'biller', clientIds: 'all' }, NOW),
    ).rejects.toThrow('need at least one client');
  });

  it('shows the invite behind a link to someone not signed in, and nothing for a wrong token', async () => {
    const [r] = await createInvitations(
      app.db,
      ctx(),
      ['viewer@invite.test'],
      { role: 'viewer', clientIds: [CLIENT] },
      NOW,
    );
    const view = await invitationByToken(app.db, r!.invite!.token, NOW);
    expect(view).toMatchObject({
      tenantName: 'Invite Billing',
      email: 'viewer@invite.test',
      role: 'viewer',
      clientCount: 1,
      inviterName: 'Priya Admin',
      status: 'pending',
      existingUser: false,
    });
    expect(await invitationByToken(app.db, 'x'.repeat(43), NOW)).toBeNull();
    expect(
      (await invitationByToken(app.db, r!.invite!.token, new Date(NOW.getTime() + 8 * 86_400_000)))!.status,
    ).toBe('expired');
  });

  it('a new person makes their sign-in first and joins only when signed in (after two-factor)', async () => {
    const [r] = await createInvitations(
      app.db,
      ctx(),
      ['fresh@invite.test'],
      { role: 'biller', clientIds: [CLIENT] },
      NOW,
    );
    const token = r!.invite!.token;
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(
      await acceptInvitationAsNewUser(
        auth,
        app.db,
        token,
        { name: 'Fresh Biller', password: PASSWORD },
        later,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(
      await acceptInvitationAsNewUser(auth, app.db, token, { name: 'Fresh Biller', password: PASSWORD }, NOW),
    ).toEqual({ ok: true, email: 'fresh@invite.test' });
    // The sign-in exists, but no membership yet, and the invite still waits.
    expect(await membership('fresh@invite.test')).toEqual([]);
    const view = await invitationByToken(app.db, token, NOW);
    expect(view).toMatchObject({ status: 'pending', existingUser: true });
    expect(
      await acceptInvitationAsNewUser(auth, app.db, token, { name: 'Again', password: PASSWORD }, NOW),
    ).toEqual({ ok: false, reason: 'existing_user' });

    const [u] = (
      await admin.db.execute<{ id: string }>(sql`select id from users where email = 'fresh@invite.test'`)
    ).rows;
    expect(
      await acceptInvitationAsUser(app.db, token, { id: u!.id, email: 'fresh@invite.test' }, NOW),
    ).toEqual({
      ok: true,
      tenantId: T,
    });
    expect(await membership('fresh@invite.test')).toEqual([
      { tenant_id: T, role: 'biller', client_scope: 'list', status: 'active' },
    ]);
    expect(
      await acceptInvitationAsUser(app.db, token, { id: u!.id, email: 'fresh@invite.test' }, NOW),
    ).toEqual({
      ok: false,
      reason: 'used',
    });
    const audit = await admin.db.execute<{ action: string }>(
      sql`select action from audit_events where tenant_id = ${T} and entity_type = 'invitation' order by at`,
    );
    expect(audit.rows.map((a) => a.action)).toContain('user.invite_accepted');
  });

  it('an existing user signs in to accept; another account cannot use their link', async () => {
    const email = `existing-${Date.now()}@invite.test`;
    const { id } = await createUserWithPassword(auth, { name: 'Already Here', email, password: PASSWORD });
    const [r] = await createInvitations(app.db, ctx(), [email], { role: 'admin', clientIds: 'all' }, NOW);
    const token = r!.invite!.token;
    expect((await invitationByToken(app.db, token, NOW))!.existingUser).toBe(true);
    expect(
      await acceptInvitationAsNewUser(auth, app.db, token, { name: 'X', password: PASSWORD }, NOW),
    ).toEqual({
      ok: false,
      reason: 'existing_user',
    });
    expect(
      await acceptInvitationAsUser(app.db, token, { id: ADMIN, email: `${ADMIN}@invite.test` }, NOW),
    ).toEqual({
      ok: false,
      reason: 'wrong_user',
    });
    expect(await acceptInvitationAsUser(app.db, token, { id, email }, NOW)).toEqual({
      ok: true,
      tenantId: T,
    });
    expect(await membership(email)).toEqual([
      { tenant_id: T, role: 'admin', client_scope: 'all', status: 'active' },
    ]);
  });

  it('resend makes a new link and retires the old one; revoke ends it', async () => {
    const [r] = await createInvitations(
      app.db,
      ctx(),
      ['resend@invite.test'],
      { role: 'viewer', clientIds: [CLIENT] },
      NOW,
    );
    const old = r!.invite!.token;
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    const res = await resendInvitation(app.db, ctx(), r!.invite!.id, later);
    expect(res).toMatchObject({ ok: true, email: 'resend@invite.test', role: 'viewer', clientCount: 1 });
    if (!res.ok) throw new Error('resend failed');
    expect(await invitationByToken(app.db, old, later)).toBeNull();
    expect((await invitationByToken(app.db, res.token, later))!.status).toBe('pending');
    expect(await revokeInvitation(app.db, ctx(), r!.invite!.id, later)).toBe(true);
    expect((await invitationByToken(app.db, res.token, later))!.status).toBe('revoked');
    expect(await revokeInvitation(app.db, ctx(), r!.invite!.id, later)).toBe(false);
  });

  it('keeps another company’s invites out of reach', async () => {
    const [r] = await createInvitations(
      app.db,
      ctx(),
      ['scoped@invite.test'],
      { role: 'viewer', clientIds: [CLIENT] },
      NOW,
    );
    expect(await revokeInvitation(app.db, { tenantId: OTHER, userId: ADMIN }, r!.invite!.id, NOW)).toBe(
      false,
    );
  });
});
