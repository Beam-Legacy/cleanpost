import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { PASSWORD, expectAccessible, setUpTwoFactor, signedInPage } from './helpers';

/**
 * Settings (S-01 and on) and the audit log (S-13). Priya is an admin; Marcus, a biller, may open
 * neither. Invites (S-02, A-06) run with email off (SMTP_HOST=log), so S-02 shows each link.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;

const HANA = 'hana@harbor-rcm.test';

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

/**
 * Hana (Harbor RCM) is invited into Northwind below; put her back out, with no invite waiting, and
 * take out the people earlier runs invited.
 */
const removeHanaFromNorthwind = () =>
  admin(async (c) => {
    await c.query(
      `delete from memberships where user_id = (select id from users where email = $1)
         and tenant_id = (select id from tenants where name = 'Northwind Billing')`,
      [HANA],
    );
    await c.query(`delete from invitations where email = $1`, [HANA]);
    // People invited by earlier local runs (CI starts from a fresh seed).
    await c.query(
      `delete from memberships where user_id in (select id from users where email like 'e2e-invite-%')`,
    );
    await c.query(`delete from invitations where email like 'e2e-invite-%'`);
  });

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await removeHanaFromNorthwind();
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
  await removeHanaFromNorthwind();
});

/** S-02 from S-01: one address, a role, the first client for billers and viewers; returns the link. */
async function invite(email: string, role: 'Admin' | 'Biller' | 'Viewer'): Promise<string> {
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite user' });
  await dialog.getByLabel('Work email').fill(email);
  await dialog.getByLabel(new RegExp(`^${role} ·`)).check();
  if (role !== 'Admin')
    await dialog.getByRole('group', { name: 'Clients' }).getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  const link = dialog.getByLabel(`Invite link for ${email}`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  const url = new URL(await link.inputValue());
  await dialog.getByRole('button', { name: 'Done' }).click();
  return `${url.pathname}${url.search}`;
}

async function anonymous(
  browser: Browser,
  use: { baseURL?: string; viewport?: { width: number; height: number } | null },
) {
  const ctx = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? null });
  return ctx.newPage();
}

test('S-01 lists everyone with role, clients and two-factor, and what each role can do', async () => {
  test.setTimeout(90_000);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/users$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Users and roles' }),
  ).toHaveAttribute('aria-current', 'page');
  const users = page.getByRole('table', { name: 'Users' });
  await expect(users.getByRole('row', { name: /Julia Beam/ })).toContainText('Owner');
  await expect(users.getByRole('row', { name: /Dana Reyes/ })).toContainText('4 clients');
  await expect(users.getByRole('row', { name: /Priya Shah \(you\)/ })).toContainText('Authenticator');
  await expect(page.getByRole('table', { name: 'What each role can do' })).toContainText(
    'Export patient-level data',
  );
  await expectAccessible(page, 'S-01');
});

test('S-13 filters the audit log by record and exports what it shows, recording the export', async () => {
  test.setTimeout(90_000);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await page.getByLabel('Record', { exact: true }).selectOption({ label: 'Claim' });
  await page.getByLabel('When', { exact: true }).selectOption('30');
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page).toHaveURL(/record=claim/);
  const rows = page.getByRole('table', { name: 'Audit events' }).locator('tbody tr');
  await expect(rows.first()).toContainText('Claim');
  await expectAccessible(page, 'S-13');

  const res = await page.request.get('/audit/export?record=claim&days=30');
  expect(res.status()).toBe(200);
  expect((await res.text()).split('\r\n')[2]).toBe(
    'When (UTC),Who,Actor,Action,Action code,Record,Record ID,Client,Details,IP address',
  );
  await page.goto('/audit?action=audit.exported');
  await expect(page.getByRole('table', { name: 'Audit events' }).locator('tbody tr').first()).toContainText(
    'Priya Shah',
  );
});

test('S-02 invites a biller; A-06 makes their sign-in, two-factor, then they join', async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const email = `e2e-invite-${Date.now()}@northwind.test`;
  const password = 'a long enough e2e password';
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  await expect(page.getByRole('dialog', { name: 'Invite user' })).toBeVisible();
  await expectAccessible(page, 'S-02');
  await page.keyboard.press('Escape');
  const link = await invite(email, 'Biller');
  const users = page.getByRole('table', { name: 'Users' });
  await expect(users.getByRole('row', { name: email })).toContainText('Invite pending');
  await expect(users.getByRole('row', { name: email })).toContainText('Biller');

  const p = await anonymous(browser, info.project.use);
  await p.goto(link);
  await expect(p.getByRole('heading', { level: 1, name: 'Join Northwind Billing' })).toBeVisible();
  await expect(p.getByText('Priya Shah invited you as a')).toContainText('with access to 1 client');
  await expect(p.getByLabel('Work email')).toHaveValue(email);
  await expectAccessible(p, 'A-06');
  await p.getByLabel('Full name').fill('Robin Vale');
  await p.getByLabel('Password').fill('too short');
  await p.getByLabel(/I agree to the terms of use/).check();
  await p.getByRole('button', { name: 'Create account' }).click();
  await expect(p.getByText('Use at least 12 characters.')).toBeVisible();
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Create account' }).click();
  await expect(p).toHaveURL(/\/setup\/two-factor\?next=/, { timeout: 30_000 });
  // No membership until two-factor is set up: S-01 still shows the invite waiting.
  await page.reload();
  await expect(users.getByRole('row', { name: email })).toContainText('Invite pending');

  await setUpTwoFactor(p, email, password);
  await p.getByRole('button', { name: 'Join Northwind Billing' }).click({ timeout: 30_000 });
  await expect(p.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible({ timeout: 30_000 });
  await p.goto(link);
  await expect(p.getByRole('heading', { level: 1, name: 'Invite already accepted' })).toBeVisible();
  await p.context().close();

  await page.reload();
  const row = users.getByRole('row', { name: email });
  await expect(row).toContainText('Robin Vale');
  await expect(row).toContainText('Biller');
  await expect(row).toContainText('Authenticator');
  await expect(row).not.toContainText('Invite pending');
});

test('Resend retires the old link; Withdraw ends the invite', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const email = `e2e-invite-${Date.now()}-w@northwind.test`;
  const first = await invite(email, 'Viewer');
  const row = page.getByRole('table', { name: 'Users' }).getByRole('row', { name: email });
  await row.getByRole('button', { name: `Invite actions for ${email}` }).click();
  await page.getByRole('menuitem', { name: 'Resend invite' }).click();
  const modal = page.getByRole('dialog', { name: 'New invite link' });
  const second = new URL(await modal.getByLabel(`Invite link for ${email}`).inputValue());
  await modal.getByRole('button', { name: 'Done' }).click();
  expect(`${second.pathname}${second.search}`).not.toBe(first);

  const p = await anonymous(browser, info.project.use);
  await p.goto(first);
  await expect(p.getByRole('heading', { level: 1, name: "This invite link doesn't work" })).toBeVisible();
  await row.getByRole('button', { name: `Invite actions for ${email}` }).click();
  await page.getByRole('menuitem', { name: 'Withdraw invite' }).click();
  await expect(row).toHaveCount(0);
  await p.goto(`${second.pathname}${second.search}`);
  await expect(p.getByRole('heading', { level: 1, name: 'This invite was withdrawn' })).toBeVisible();
  await p.context().close();
});

test('someone with an account signs in from the link, sets up two-factor and joins', async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const link = await invite(HANA, 'Viewer');
  const p = await anonymous(browser, info.project.use);
  await p.goto(link);
  await expect(p.getByText('already has a Cleanpost account')).toBeVisible();
  await p.getByRole('link', { name: 'Sign in to accept' }).click();
  await expect(p).toHaveURL(/\/sign-in\?next=/);
  await p.getByLabel('Work email').fill(HANA);
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Global setup cleared her two-factor, so the invite asks for it first and then brings her back.
  await p.getByRole('link', { name: 'Set up two-factor sign-in' }).click({ timeout: 30_000 });
  await expect(p).toHaveURL(/\/setup\/two-factor\?next=/);
  await setUpTwoFactor(p, HANA);
  await p.getByRole('button', { name: 'Join Northwind Billing' }).click({ timeout: 30_000 });
  await expect(p.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible({ timeout: 30_000 });
  await p.context().close();

  await page.goto('/settings/users');
  const row = page.getByRole('table', { name: 'Users' }).getByRole('row', { name: /Hana Okoye/ });
  await expect(row).toContainText('Viewer');
  await expect(row).toContainText('Authenticator');
});

test('a biller can open neither settings nor the audit log', async ({ browser }, info) => {
  const biller = await signedInPage(browser, info.project.use, 'marcus@northwind.test');
  for (const path of ['/settings/users', '/audit']) {
    await biller.goto(path);
    await expect(biller.getByText(/You don.t have access/)).toBeVisible();
  }
  await biller.context().close();
});
