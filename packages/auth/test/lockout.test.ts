import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { memoryMailer } from '@cleanpost/email';
import { ACCOUNT_LOCKED, createAuth, createUserWithPassword, describeDevice, type Auth } from '../src';

const { adminUrl, url } = testDatabaseUrls();
const PASSWORD = 'a long enough password';
const mailer = memoryMailer();
let app: DatabaseHandle;
let admin: DatabaseHandle;
let auth: Auth;

beforeAll(async () => {
  app = createDatabase(url, { max: 3 });
  admin = createDatabase(adminUrl, { max: 1 });
  auth = createAuth({ db: app.db, mailer, secret: 's'.repeat(32), appUrl: 'http://localhost:3000' });
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

const signIn = (email: string, password: string, userAgent = 'Mozilla/5.0 (Macintosh) Chrome/140.0') =>
  auth.api.signInEmail({ body: { email, password }, headers: new Headers({ 'user-agent': userAgent }) });

describe('A-08 lockout', () => {
  it('locks after 5 wrong passwords, refuses the right one while locked, and emails the user', async () => {
    const email = `lock-${Date.now()}@northwind.test`;
    await createUserWithPassword(auth, { name: 'Marcus Lee', email, password: PASSWORD });
    for (let i = 0; i < 5; i++) await expect(signIn(email, 'not the password!')).rejects.toBeDefined();
    await expect(signIn(email, PASSWORD)).rejects.toMatchObject({ body: { code: ACCOUNT_LOCKED } });
    expect(mailer.sent.filter((m) => m.to === email).map((m) => m.content.subject)).toContain(
      'Your Cleanpost account is locked for 15 minutes',
    );

    await admin.db.execute(
      sql`update users set locked_until = now() - interval '1 minute' where email = ${email}`,
    );
    await expect(signIn(email, PASSWORD)).resolves.toBeDefined();
    const r = await admin.pool.query('select failed_sign_in_count from users where email = $1', [email]);
    expect(r.rows[0].failed_sign_in_count).toBe(0);
  });
});

describe('E-03 new sign-in alert', () => {
  it('emails on a new device family but not on the first sign-in or a known device', async () => {
    const email = `device-${Date.now()}@northwind.test`;
    await createUserWithPassword(auth, { name: 'Priya Shah', email, password: PASSWORD });
    const alerts = () =>
      mailer.sent.filter((m) => m.to === email && m.content.subject.startsWith('New sign-in'));

    await signIn(email, PASSWORD, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/140.0');
    await signIn(email, PASSWORD, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/141.0');
    expect(alerts()).toHaveLength(0);

    await signIn(email, PASSWORD, 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.content.text).toContain('Device: Firefox on Windows');
  });

  it('labels common devices', () => {
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1')).toBe(
      'Safari on iOS',
    );
    expect(describeDevice(null)).toBe('A browser on an unknown system');
  });
});
