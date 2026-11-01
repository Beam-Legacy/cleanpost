import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { memoryMailer } from '@cleanpost/email';
import {
  chooseCompany,
  createAuth,
  createUserWithPassword,
  getSessionContext,
  NotAMemberError,
  type Auth,
} from '../src';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { totpFromUri } from './totp';

const PASSWORD = 'correct horse battery staple';
const { adminUrl: TEST_DATABASE_ADMIN_URL, url: TEST_DATABASE_URL } = testDatabaseUrls();
let app: DatabaseHandle;
let admin: DatabaseHandle;
let auth: Auth;
const mailer = memoryMailer();
const tenantId = uuidv7();
const otherTenantId = uuidv7();
let userId: string;
const email = `dana-${Date.now()}@northwind.test`;

/** Turns Set-Cookie response headers into a Cookie request header. */
function cookiesFrom(headers: Headers, previous = new Headers()): Headers {
  const jar = new Map<string, string>();
  for (const part of (previous.get('cookie') ?? '').split('; ').filter(Boolean)) {
    const [k, ...v] = part.split('=');
    jar.set(k!, v.join('='));
  }
  for (const c of headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.split('=');
    if (v.join('=') === '') jar.delete(k!);
    else jar.set(k!, v.join('='));
  }
  return new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
}

async function signIn(): Promise<{ headers: Headers; twoFactorRedirect: boolean }> {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
  return {
    headers: cookiesFrom(res.headers),
    twoFactorRedirect: Boolean((res.response as { twoFactorRedirect?: boolean }).twoFactorRedirect),
  };
}

beforeAll(async () => {
  app = createDatabase(TEST_DATABASE_URL, { max: 3 });
  admin = createDatabase(TEST_DATABASE_ADMIN_URL, { max: 1 });
  auth = createAuth({ db: app.db, mailer, secret: 's'.repeat(32), appUrl: 'http://localhost:3000' });
  ({ id: userId } = await createUserWithPassword(auth, { name: 'Dana Reyes', email, password: PASSWORD }));
  await admin.db.execute(sql`insert into tenants (id, name) values (${tenantId}, 'Northwind Billing')`);
  await admin.db.execute(sql`insert into tenants (id, name) values (${otherTenantId}, 'Harbor RCM')`);
  await admin.db.execute(
    sql`insert into memberships (tenant_id, user_id, role, client_scope) values (${tenantId}, ${userId}, 'biller', 'all')`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('sign-in with a required second factor', () => {
  let totpUri = '';

  it('rejects a wrong password', async () => {
    await expect(
      auth.api.signInEmail({ body: { email, password: 'wrong password!!' } }),
    ).rejects.toBeDefined();
  });

  it('requires two-factor setup before anything else (A-03)', async () => {
    const { headers } = await signIn();
    const ctx = await getSessionContext(auth, app.db, headers);
    expect(ctx.status).toBe('mfa_setup_required');

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    if (enabled.method !== 'totp') throw new Error('expected TOTP setup');
    totpUri = enabled.totpURI;
    expect(enabled.backupCodes).toHaveLength(10);
    // Verifying the first code turns two-factor on and replaces the session cookie.
    const verified = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpUri) },
      headers,
      returnHeaders: true,
    });
    const after = cookiesFrom(verified.headers, headers);
    expect((await getSessionContext(auth, app.db, after)).status).toBe('choose_company');
  });

  it('asks for the code at every later sign-in (A-02)', async () => {
    const first = await signIn();
    expect(first.twoFactorRedirect).toBe(true);
    expect((await getSessionContext(auth, app.db, first.headers)).status).toBe('signed_out');

    const verified = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpUri) },
      headers: first.headers,
      returnHeaders: true,
    });
    const headers = cookiesFrom(verified.headers, first.headers);
    const ctx = await getSessionContext(auth, app.db, headers);
    expect(ctx.status).toBe('choose_company');
    if (ctx.status !== 'choose_company') return;

    await expect(chooseCompany(app.db, ctx.sessionId, userId, otherTenantId)).rejects.toThrow(
      NotAMemberError,
    );
    await chooseCompany(app.db, ctx.sessionId, userId, tenantId);
    const ok = await getSessionContext(auth, app.db, headers);
    expect(ok).toMatchObject({ status: 'ok', tenantId, actor: { role: 'biller', clientScope: 'all' } });

    // 12-hour absolute limit (docs/11-security-hipaa.md), even for an active session.
    await admin.db.execute(
      sql`update sessions set created_at = now() - interval '13 hours' where id = ${ctx.sessionId}`,
    );
    expect(await getSessionContext(auth, app.db, headers)).toEqual({
      status: 'signed_out',
      reason: 'expired',
    });
  });

  it('sends the E-02 reset email without signing anyone in', async () => {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: 'http://localhost:3000/reset-password' },
    });
    expect(mailer.sent.at(-1)).toMatchObject({ to: email, template: 'E-02' });
  });
});
