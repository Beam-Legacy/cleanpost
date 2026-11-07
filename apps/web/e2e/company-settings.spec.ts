import { expect, test, type Page } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import pg from 'pg';
import { expectAccessible, savedKey, signedInPage } from './helpers';
import { totp } from './totp';

/**
 * S-14 company profile, S-12 security and S-10 branding with F-01 (DEC-34). Priya is a Northwind
 * admin. Everything a test changes is put back in afterAll, so other specs see the seeded company.
 */
test.describe.configure({ mode: 'serial' });

const PRIYA = 'priya@northwind.test';
let page: Page;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const NORTHWIND = `(select id from tenants where name = 'Northwind Billing')`;

/** Back to the seeded profile, default security and no branding. */
const restore = () =>
  admin(async (c) => {
    await c.query(
      `delete from document_blobs where tenant_id = ${NORTHWIND} and storage_key like 'branding/logo/%'`,
    );
    await c.query(
      `update tenants set phone = '(503) 555-0142',
         security_contact = '{"name": "Priya Shah", "email": "priya@northwind.test"}',
         settings = settings - 'security' - 'branding'
       where id = ${NORTHWIND}`,
    );
    await c.query(`update tenant_agreements set signed_at = '2026-07-18T17:00:00Z'
      where tenant_id = ${NORTHWIND} and type = 'baa'`);
  });

/** A real PNG of one color, so the browser draws it and the server reads its width. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x33)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await restore();
  page = await signedInPage(browser, info.project.use, PRIYA);
});

test.afterAll(async () => {
  await page.context().close();
  await restore();
});

test('S-14 saves the profile, checks the contacts, downloads the BAA and warns without one', async () => {
  test.setTimeout(90_000);
  await page.goto('/settings/company');
  await expect(page.getByRole('heading', { name: 'Company profile' })).toBeVisible();
  await expect(page.getByLabel('Legal name')).toHaveValue('Northwind Billing LLC');
  await expect(page.getByText('Version 2026.1 · signed by Julia Beam, Jul 18, 2026').first()).toBeVisible();
  await expectAccessible(page, 'S-14');

  const href = await page
    .getByRole('link', { name: 'Download the business associate agreement' })
    .getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toMatch(/^attachment/);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await page.getByLabel('Security contact email').fill('not an address');
  await page.getByLabel('Main phone').fill('(503) 555-0199');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter an email address.')).toBeVisible();
  await page.getByLabel('Security contact email').fill('security@northwind.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Company profile saved.')).toBeVisible();
  const saved = await admin((c) =>
    c.query(`select phone, security_contact->>'email' as email from tenants where id = ${NORTHWIND}`),
  );
  expect(saved.rows[0]).toEqual({ phone: '(503) 555-0199', email: 'security@northwind.test' });
  const audit = await admin((c) =>
    c.query(`select metadata from audit_events where tenant_id = ${NORTHWIND}
      and action = 'company.profile_updated' order by at desc, id desc limit 1`),
  );
  expect(audit.rows[0].metadata.fields).toEqual(expect.arrayContaining(['phone', 'securityContact']));
  // Field names only: the audit log never holds the contact's address or the phone number.
  expect(JSON.stringify(audit.rows[0].metadata)).not.toContain('northwind.test');

  await admin((c) =>
    c.query(`update tenant_agreements set signed_at = null where tenant_id = ${NORTHWIND} and type = 'baa'`),
  );
  await page.reload();
  await expect(page.getByText('No business associate agreement on file.')).toBeVisible();
});

test('S-12 refuses a list that locks the saver out, then saves after the second step again', async () => {
  test.setTimeout(90_000);
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  await expect(page.getByText('Required for every user. Cannot be turned off.')).toBeVisible();
  await expectAccessible(page, 'S-12');

  const allowlist = page.getByLabel('Allowed IP addresses');
  await allowlist.fill('10.0.0.0/8\nnot-an-ip');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Line 2 is not an IP address or range: "not-an-ip".')).toBeVisible();
  await allowlist.fill('203.0.113.0/24');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText(/leaves out your own address|can't see the address you're connecting from/),
  ).toBeVisible();

  await allowlist.fill('');
  await page.getByLabel('Sign out after inactivity').selectOption('30');
  // The second step was entered at sign-in; make it older than 10 minutes so Save asks again.
  await admin((c) =>
    c.query(
      `update sessions set second_factor_at = now() - interval '11 minutes'
         where user_id = (select id from users where email = $1)`,
      [PRIYA],
    ),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, 'S-12 step-up');
  await dialog.getByLabel('Code from your authenticator app').fill(totp(savedKey(PRIYA)));
  await dialog.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(page.getByText(/^Security settings saved\./)).toBeVisible({ timeout: 15_000 });
  const saved = await admin((c) =>
    c.query(`select settings->'security'->>'idleMinutes' as idle from tenants where id = ${NORTHWIND}`),
  );
  expect(saved.rows[0].idle).toBe('30');
  const audit = await admin((c) =>
    c.query(`select metadata from audit_events where tenant_id = ${NORTHWIND}
      and action = 'security.settings_updated' order by at desc, id desc limit 1`),
  );
  expect(audit.rows[0].metadata.changes.idleMinutes).toEqual({ from: 15, to: 30 });
});

test('S-10 checks the logo, previews as typed, and F-01 carries the branding', async () => {
  test.setTimeout(120_000);
  await page.goto('/settings/branding');
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  const preview = page.getByRole('figure', { name: 'Preview' });
  await expect(preview).toContainText('Northwind Billing');
  await expect(preview).not.toContainText('Prepared with Cleanpost');
  await expectAccessible(page, 'S-10');
  const href = await page.getByRole('link', { name: 'Open full preview' }).getAttribute('href');

  // No logo yet: F-01 prints the name as text and the toolbar says where to add one.
  await page.goto(href!);
  await expect(page.getByText('Uses Northwind Billing as text.')).toBeVisible();
  await expect(page.getByRole('article').locator('footer')).not.toContainText('Cleanpost');
  await page.getByRole('link', { name: 'Add a logo in Branding.' }).click();
  await expect(page).toHaveURL(/\/settings\/branding$/);

  const logo = page.getByLabel('Logo');
  await logo.setInputFiles({ name: 'small.png', mimeType: 'image/png', buffer: png(120, 40) });
  await expect(page.getByText('The logo is 120 px wide. Use one at least 200 px wide.')).toBeVisible();
  await logo.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(240, 60) });
  await expect(page.getByText('Logo saved.')).toBeVisible({ timeout: 15_000 });
  await expect(preview.locator('img')).toBeVisible();

  await page.getByLabel('Company name on reports').fill('Northwind Billing Partners');
  await page.getByLabel('Contact line').fill('reports@northwind.test · (503) 555-0142');
  await page.getByLabel('Show "Prepared with Cleanpost" in the footer').check();
  await expect(preview).toContainText('Northwind Billing Partners');
  await expect(preview).toContainText('Questions? reports@northwind.test');
  await expect(preview).toContainText('Prepared with Cleanpost');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Branding saved\./)).toBeVisible();

  await page.goto(href!);
  await expect(page.getByText(/as text\./)).toHaveCount(0);
  const report = page.getByRole('article');
  await expect(report.getByRole('img', { name: 'Northwind Billing Partners' })).toBeVisible();
  const foot = report.locator('footer');
  await expect(foot).toContainText('Northwind Billing Partners · Confidential');
  await expect(foot).toContainText('Questions? reports@northwind.test · (503) 555-0142');
  await expect(foot).toContainText('Prepared with Cleanpost');

  await page.goto('/settings/branding');
  await page.getByLabel('Show "Prepared with Cleanpost" in the footer').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Branding saved\./)).toBeVisible();
  await page.goto(href!);
  await expect(page.getByRole('article').locator('footer')).not.toContainText('Cleanpost');
});
