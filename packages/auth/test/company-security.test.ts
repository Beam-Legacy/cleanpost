import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { memoryMailer } from '@cleanpost/email';
import {
  chooseCompany,
  createAuth,
  createUserWithPassword,
  forgetTrustedDevices,
  getSessionContext,
  pendingTwoFactorUser,
  stepUpFresh,
  trustedDevicesAllowed,
  type Auth,
} from '../src';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { totpFromUri } from './totp';

/**
 * DEC-34: each session records how its second step was done, a password alone is not enough for
 * someone whose second factor is a passkey, and the chosen company's S-12 settings apply on every
 * request (idle and absolute limits, passkeys, trusted devices, IP allowlist).
 */
const PASSWORD = 'correct horse battery staple';
const SECRET = 's'.repeat(32);
const { adminUrl, url } = testDatabaseUrls();
let app: DatabaseHandle;
let admin: DatabaseHandle;
let auth: Auth;
const tenantId = uuidv7();
const stamp = Date.now();
const totpEmail = `lena-${stamp}@northwind.test`;
const passkeyEmail = `marcus-${stamp}@northwind.test`;
let totpUserId: string;
let passkeyUserId: string;
let totpUri = '';

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
  const out = new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
  const ip = previous.get('x-forwarded-for');
  if (ip) out.set('x-forwarded-for', ip);
  return out;
}

const cookie = (headers: Headers, name: string) =>
  (headers.get('cookie') ?? '')
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

async function signIn(email: string, previous = new Headers()) {
  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    headers: previous,
    returnHeaders: true,
  });
  return {
    headers: cookiesFrom(res.headers, previous),
    twoFactorRedirect: Boolean((res.response as { twoFactorRedirect?: boolean }).twoFactorRedirect),
  };
}

/** Password, then the code, then the company: a working session's headers. */
async function signedIn(opts: { trustDevice?: boolean; ip?: string } = {}) {
  const start = new Headers(opts.ip ? { 'x-forwarded-for': opts.ip } : {});
  const first = await signIn(totpEmail, start);
  const verified = await auth.api.verifyTOTP({
    body: { code: totpFromUri(totpUri), ...(opts.trustDevice ? { trustDevice: true } : {}) },
    headers: first.headers,
    returnHeaders: true,
  });
  const headers = cookiesFrom(verified.headers, first.headers);
  const ctx = await getSessionContext(auth, app.db, headers);
  if (ctx.status !== 'choose_company') throw new Error(`expected choose_company, got ${ctx.status}`);
  expect(await chooseCompany(app.db, ctx.sessionId, totpUserId, tenantId, opts.ip ?? null)).toBeNull();
  return { headers, sessionId: ctx.sessionId };
}

const session = async (id: string) =>
  (
    await admin.db.execute<{ second_factor: string | null; second_factor_at: Date | null }>(
      sql`select second_factor, second_factor_at from sessions where id = ${id}`,
    )
  ).rows[0]!;

async function security(values: Record<string, unknown>) {
  await admin.db.execute(
    sql`update tenants set settings = jsonb_set(settings, '{security}', ${JSON.stringify(values)}::jsonb) where id = ${tenantId}`,
  );
}

beforeAll(async () => {
  app = createDatabase(url, { max: 3 });
  admin = createDatabase(adminUrl, { max: 1 });
  auth = createAuth({ db: app.db, mailer: memoryMailer(), secret: SECRET, appUrl: 'http://localhost:3000' });
  ({ id: totpUserId } = await createUserWithPassword(auth, {
    name: 'Lena Ortiz',
    email: totpEmail,
    password: PASSWORD,
  }));
  ({ id: passkeyUserId } = await createUserWithPassword(auth, {
    name: 'Marcus Lee',
    email: passkeyEmail,
    password: PASSWORD,
  }));
  await admin.db.execute(sql`insert into tenants (id, name) values (${tenantId}, 'Northwind Billing')`);
  for (const u of [totpUserId, passkeyUserId])
    await admin.db.execute(
      sql`insert into memberships (tenant_id, user_id, role, client_scope) values (${tenantId}, ${u}, 'admin', 'all')`,
    );
  // Lena sets up an authenticator; Marcus has only a passkey.
  const { headers } = await signIn(totpEmail);
  const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
  if (enabled.method !== 'totp') throw new Error('expected TOTP');
  totpUri = enabled.totpURI;
  await auth.api.verifyTOTP({ body: { code: totpFromUri(totpUri) }, headers });
  await admin.db
    .execute(sql`insert into passkeys (public_key, user_id, credential_id, counter, device_type, backed_up)
    values ('pk', ${passkeyUserId}, ${`cred-${stamp}`}, 0, 'singleDevice', false)`);
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('how a session was verified', () => {
  it('records the authenticator code, and a code entered later refreshes it (step-up)', async () => {
    const { headers, sessionId } = await signedIn();
    expect(await session(sessionId)).toMatchObject({ second_factor: 'totp' });
    expect(await stepUpFresh(app.db, sessionId)).toBe(true);
    await admin.db.execute(
      sql`update sessions set second_factor_at = now() - interval '20 minutes' where id = ${sessionId}`,
    );
    expect(await stepUpFresh(app.db, sessionId)).toBe(false);
    // Signed in already: the code confirms it is them, no new session.
    await auth.api.verifyTOTP({ body: { code: totpFromUri(totpUri) }, headers });
    expect(await stepUpFresh(app.db, sessionId)).toBe(true);
  });

  it('does not take a password alone from someone whose second factor is a passkey', async () => {
    const { headers } = await signIn(passkeyEmail);
    const ctx = await getSessionContext(auth, app.db, headers);
    expect(ctx.status).toBe('second_factor_required');
    if (ctx.status !== 'second_factor_required') return;
    expect(await session(ctx.sessionId)).toMatchObject({ second_factor: null });
    // With the passkey (as /passkey/verify-authentication records it), the session goes on.
    await admin.db.execute(sql`update sessions set second_factor = 'passkey' where id = ${ctx.sessionId}`);
    expect((await getSessionContext(auth, app.db, headers)).status).toBe('choose_company');
  });

  it('knows who is between the password and the code from the signed two-factor cookie', async () => {
    const first = await signIn(totpEmail);
    expect(first.twoFactorRedirect).toBe(true);
    const value = cookie(first.headers, 'cleanpost.two_factor');
    expect(await pendingTwoFactorUser(app.db, value, SECRET)).toBe(totpUserId);
    expect(await pendingTwoFactorUser(app.db, value, 'x'.repeat(32))).toBeNull();
    expect(await pendingTwoFactorUser(app.db, value?.replace(/^./, 'z'), SECRET)).toBeNull();
    expect(await pendingTwoFactorUser(app.db, undefined, SECRET)).toBeNull();
  });
});

describe("the company's S-12 settings, on every request", () => {
  it('signs a session out after the company idle limit, 15 or 30 minutes', async () => {
    await security({});
    const { headers, sessionId } = await signedIn();
    // Last active 20 minutes ago (better-auth's expiry is the last activity plus 30 minutes).
    await admin.db.execute(
      sql`update sessions set expires_at = now() + interval '10 minutes' where id = ${sessionId}`,
    );
    await security({ idleMinutes: 30 });
    expect(await getSessionContext(auth, app.db, headers)).toMatchObject({ status: 'ok', idleMinutes: 30 });
    await admin.db.execute(
      sql`update sessions set expires_at = now() + interval '10 minutes' where id = ${sessionId}`,
    );
    await security({ idleMinutes: 15 });
    expect(await getSessionContext(auth, app.db, headers)).toEqual({
      status: 'signed_out',
      reason: 'expired',
    });
  });

  it('ends a session at the company maximum length', async () => {
    await security({ absoluteHours: 4 });
    const { headers, sessionId } = await signedIn();
    await admin.db.execute(
      sql`update sessions set created_at = now() - interval '5 hours' where id = ${sessionId}`,
    );
    expect(await getSessionContext(auth, app.db, headers)).toEqual({
      status: 'signed_out',
      reason: 'expired',
    });
    await security({});
  });

  it('turns away a passkey session where passkeys are off, and says why at A-07', async () => {
    const { headers, sessionId } = await signedIn();
    await admin.db.execute(sql`update sessions set second_factor = 'passkey' where id = ${sessionId}`);
    await security({ allowPasskeys: false });
    expect(await getSessionContext(auth, app.db, headers)).toMatchObject({
      status: 'company_blocked',
      reason: 'passkeys_not_allowed',
    });
    expect(await chooseCompany(app.db, sessionId, totpUserId, tenantId)).toBe('passkeys_not_allowed');
    await security({});
    expect(await chooseCompany(app.db, sessionId, totpUserId, tenantId)).toBeNull();
    expect((await getSessionContext(auth, app.db, headers)).status).toBe('ok');
  });

  it('lets a device skip the code only for 12 hours and only where the company allows it', async () => {
    await security({});
    expect(await trustedDevicesAllowed(app.db, totpUserId)).toBe(false);
    await security({ trustedDevices: true });
    expect(await trustedDevicesAllowed(app.db, totpUserId)).toBe(true);
    const { headers } = await signedIn({ trustDevice: true });
    const trust = cookie(headers, 'cleanpost.trust_device');
    expect(trust).toBeTruthy();
    // The next sign-in on this device skips the code: recorded as a trusted device.
    const again = await signIn(totpEmail, new Headers({ cookie: `cleanpost.trust_device=${trust}` }));
    expect(again.twoFactorRedirect).toBe(false);
    const ctx = await getSessionContext(auth, app.db, again.headers);
    if (ctx.status !== 'choose_company') throw new Error(ctx.status);
    expect(await session(ctx.sessionId)).toMatchObject({
      second_factor: 'trusted_device',
      second_factor_at: null,
    });
    expect(await stepUpFresh(app.db, ctx.sessionId)).toBe(false);
    expect(await chooseCompany(app.db, ctx.sessionId, totpUserId, tenantId)).toBeNull();
    // The company turns trusted devices off: that session is turned away.
    await security({ trustedDevices: false });
    expect(await getSessionContext(auth, app.db, again.headers)).toMatchObject({
      status: 'company_blocked',
      reason: 'trusted_devices_not_allowed',
    });
    // Forgotten: the code is asked for again.
    await forgetTrustedDevices(app.db, totpUserId);
    const third = await signIn(totpEmail, new Headers({ cookie: `cleanpost.trust_device=${trust}` }));
    expect(third.twoFactorRedirect).toBe(true);
  });

  it('allows sign-in only from the allowlist, reading the address the proxy added', async () => {
    await security({ ipAllowlist: ['203.0.113.0/24'] });
    const { headers, sessionId } = await signedIn({ ip: '203.0.113.9' });
    expect((await getSessionContext(auth, app.db, headers)).status).toBe('ok');
    // A client that claims an allowed address in front of the real one gets nowhere.
    headers.set('x-forwarded-for', '203.0.113.9, 198.51.100.24');
    expect(await getSessionContext(auth, app.db, headers)).toMatchObject({
      status: 'company_blocked',
      reason: 'network',
    });
    expect(await chooseCompany(app.db, sessionId, totpUserId, tenantId, '198.51.100.24')).toBe('network');
    await security({});
  });
});
