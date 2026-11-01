import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { memoryMailer } from '@cleanpost/email';
import {
  createAuth,
  createUserWithPassword,
  getSessionContext,
  skipSecondFactorForSession,
  SkipNotAllowedError,
  type Auth,
} from '../src';

const { url } = testDatabaseUrls();
const PASSWORD = 'a long enough password';
let app: DatabaseHandle;
let auth: Auth;

beforeAll(async () => {
  app = createDatabase(url, { max: 2 });
  auth = createAuth({
    db: app.db,
    mailer: memoryMailer(),
    secret: 's'.repeat(32),
    appUrl: 'http://localhost:3000',
  });
});
afterAll(() => app.close());
afterEach(() => {
  delete process.env.CLEANPOST_ENV;
  delete process.env.PREVIEW_ALLOW_SKIP_2FA;
});

async function signedIn(email: string) {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return new Headers({ cookie });
}

describe('preview skip for two-factor setup', () => {
  it('is not offered or allowed by default', async () => {
    const email = `noskip-${Date.now()}@northwind.test`;
    await createUserWithPassword(auth, { name: 'Marcus Lee', email, password: PASSWORD });
    const ctx = await getSessionContext(auth, app.db, await signedIn(email));
    expect(ctx).toMatchObject({ status: 'mfa_setup_required', canSkip: false });
    if (ctx.status !== 'mfa_setup_required') return;
    await expect(skipSecondFactorForSession(app.db, ctx.sessionId)).rejects.toThrow(SkipNotAllowedError);
  });

  it('in preview, lets one session through and asks again at the next sign-in', async () => {
    process.env.CLEANPOST_ENV = 'preview';
    process.env.PREVIEW_ALLOW_SKIP_2FA = 'true';
    const email = `skip-${Date.now()}@northwind.test`;
    await createUserWithPassword(auth, { name: 'Dana Reyes', email, password: PASSWORD });

    const first = await signedIn(email);
    const ctx = await getSessionContext(auth, app.db, first);
    expect(ctx).toMatchObject({ status: 'mfa_setup_required', canSkip: true });
    if (ctx.status !== 'mfa_setup_required') return;
    await skipSecondFactorForSession(app.db, ctx.sessionId);
    expect((await getSessionContext(auth, app.db, first)).status).toBe('choose_company');

    const second = await signedIn(email);
    expect((await getSessionContext(auth, app.db, second)).status).toBe('mfa_setup_required');
  });

  it('cannot be switched on in production', async () => {
    process.env.CLEANPOST_ENV = 'production';
    process.env.PREVIEW_ALLOW_SKIP_2FA = 'true';
    await expect(skipSecondFactorForSession(app.db, '01a00000-0000-7000-8000-000000000000')).rejects.toThrow(
      'PREVIEW_ALLOW_SKIP_2FA',
    );
  });
});
