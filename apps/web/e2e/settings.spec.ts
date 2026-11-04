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
/** The person the S-02 test invites; S-03 then edits them. */
let invitee = '';

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
    // The S-08 test maps OA-94 company-wide.
    await c.query(`delete from adjustment_mappings where carc = '94' and client_id is null`);
    // The S-05 test switches a built-in rule off and back on; start from none off.
    await c.query(`update tenants set settings = settings - 'rulesOff' where name = 'Northwind Billing'`);
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
  invitee = email;
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

test('S-03 changes role and clients, signs them out, resets two-factor, deactivates and reactivates', async () => {
  test.setTimeout(120_000);
  expect(invitee).not.toBe('');
  await page.goto('/settings/users');
  const users = page.getByRole('table', { name: 'Users' });
  const row = users.getByRole('row', { name: invitee });
  await row.getByRole('button', { name: 'Edit Robin Vale' }).click();
  const drawer = page.getByRole('dialog', { name: 'Robin Vale' });
  await expect(drawer).toContainText('Authenticator app');
  await expectAccessible(page, 'S-03');
  await drawer.getByLabel(/^Viewer ·/).check();
  await drawer.getByRole('group', { name: 'Clients' }).getByRole('checkbox').nth(1).check();
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer).toBeHidden();
  await expect(row).toContainText('Viewer');
  await expect(row).toContainText('2 clients');

  await row.getByRole('button', { name: 'Edit Robin Vale' }).click();
  await drawer.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByText(/Signed out of \d+ sessions?\./)).toBeVisible();
  await drawer.getByRole('button', { name: 'Reset two-factor' }).click();
  await expect(page.getByText('Two-factor reset.')).toBeVisible();
  await expect(drawer).toContainText('Not set up yet');
  await drawer.getByRole('button', { name: 'Deactivate' }).click();
  await page
    .getByRole('alertdialog', { name: 'Deactivate Robin Vale?' })
    .getByRole('button', { name: 'Deactivate Robin Vale' })
    .click();
  await expect(row).toContainText('Deactivated');

  await row.getByRole('button', { name: 'Edit Robin Vale' }).click();
  await drawer.getByRole('button', { name: 'Reactivate' }).click();
  await expect(row).not.toContainText('Deactivated');
  await expect(row).toContainText('Not set up');

  await page.goto('/audit?action=user.deactivated&days=1');
  await expect(page.getByRole('table', { name: 'Audit events' }).locator('tbody tr').first()).toContainText(
    'Priya Shah',
  );
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
  // She works in Harbor RCM too, so her two-factor is not Northwind's to reset (DEC-22).
  await row.getByRole('button', { name: 'Edit Hana Okoye' }).click();
  const drawer = page.getByRole('dialog', { name: 'Hana Okoye' });
  await expect(drawer.getByRole('button', { name: 'Reset two-factor' })).toBeDisabled();
  await expect(drawer).toContainText('They also work in another company');
  await page.keyboard.press('Escape');
});

test("S-08 shows each PM's mappings, maps a code company-wide, and refuses a denial code", async () => {
  test.setTimeout(90_000);
  await page.goto('/settings/mappings');
  await expect(page.getByRole('heading', { name: 'Adjustment mappings' })).toBeVisible();
  const table = page.getByRole('table', { name: /adjustment mappings$/ });
  await expect(table.getByRole('row', { name: /CO-45/ })).toContainText('Cleanpost default');
  await expectAccessible(page, 'S-08');

  const add = page.getByRole('form', { name: 'Add a code' });
  await add.getByLabel('Group').selectOption('OA');
  await add.getByLabel('Reason code').fill('94');
  await add.getByLabel(/^(?!Reason).+ code$/).fill('oa94');
  await add.getByLabel('What it does').selectOption('adjust');
  await add.getByRole('button', { name: 'Add code' }).click();
  const row = table.getByRole('row', { name: /OA-94/ });
  await expect(row).toContainText('OA94');
  await expect(row).toContainText('Your mapping');

  await row.getByRole('button', { name: 'Edit OA-94' }).click();
  await row.getByRole('textbox').fill('OA94X');
  await row.getByRole('button', { name: 'Save OA-94' }).click();
  await expect(row).toContainText('OA94X');

  await add.getByLabel('Group').selectOption('CO');
  await add.getByLabel('Reason code').fill('4');
  await add.getByLabel(/^(?!Reason).+ code$/).fill('WO');
  await add.getByRole('button', { name: 'Add code' }).click();
  await expect(page.getByText('CO-4 is a denial')).toBeVisible();
  await expect(table.getByRole('row', { name: /CO-4\b/ })).toHaveCount(0);
});

test('S-04 sets the default threshold with a simulation, asks before lowering a lot, and sets a client', async () => {
  test.setTimeout(90_000);
  await page.goto('/settings/automation');
  await expect(page.getByRole('heading', { name: 'Automation', level: 2 })).toBeVisible();
  const number = page.getByLabel('Default release threshold, number');
  await expect(number).toHaveValue('90');
  await expectAccessible(page, 'S-04');

  await number.fill('80');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Lower the default to 80?' });
  await confirm.getByRole('button', { name: 'Lower to 80' }).click();
  await expect(page.getByText('Default threshold 90 → 80.')).toBeVisible();
  await number.fill('90');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Default threshold 80 → 90.')).toBeVisible();

  const table = page.getByRole('table', { name: 'Client release thresholds' });
  const row = table.locator('tbody tr').first();
  const name = (await row.locator('th').innerText()).trim();
  await row.getByRole('button', { name: `Edit ${name}` }).click();
  await row.getByLabel(`Threshold for ${name}`).selectOption('review');
  await row.getByRole('button', { name: `Save ${name}` }).click();
  await expect(row).toContainText('Review everything');
  await row.getByRole('button', { name: `Edit ${name}` }).click();
  await row.getByLabel(`Threshold for ${name}`).selectOption('default');
  await row.getByRole('button', { name: `Save ${name}` }).click();
  await expect(row).toContainText('Default (90)');

  await page.goto('/audit?action=automation.threshold_changed&days=1');
  await expect(page.getByRole('table', { name: 'Audit events' }).locator('tbody tr').first()).toContainText(
    'Priya Shah',
  );
});

test('S-05 lists rules with hits; S-06 explains one, tests it, and turns a built-in off and back on', async () => {
  test.setTimeout(120_000);
  await page.goto('/settings/rules');
  await expect(page.getByRole('heading', { name: 'Rules', level: 2 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Rules' });
  await expect(table.getByRole('row', { name: /Side of the body on lateral procedures/ })).toContainText(
    'Built in',
  );
  await expectAccessible(page, 'S-05');

  await table.getByRole('button', { name: 'Side of the body on lateral procedures' }).click();
  const drawer = page.getByRole('dialog', { name: 'Side of the body on lateral procedures' });
  await expect(drawer.getByRole('region', { name: 'When' })).toContainText(
    'A line has one of the procedures done on one side of the body',
  );
  await expect(drawer.getByRole('region', { name: 'Then' })).toContainText('Flag a warning');
  await expectAccessible(page, 'S-06');
  await drawer.getByRole('button', { name: 'Test on last 30 days' }).click();
  await expect(drawer.getByRole('status')).toContainText('On the last 30 days this rule would have matched');

  const pick = drawer.getByLabel('Turn off for one client');
  const client = (await pick.locator('option').nth(1).innerText()).trim();
  await pick.selectOption({ label: client });
  await drawer.getByRole('button', { name: 'Turn off for this client' }).click();
  await expect(drawer.getByText(`Off for ${client}`, { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: `Turn back on for ${client}` }).click();
  await expect(drawer.getByText(`Off for ${client}`, { exact: true })).toHaveCount(0);

  await drawer.getByRole('button', { name: 'Turn off for the company' }).click();
  await page
    .getByRole('alertdialog', { name: /Turn off "Side of the body/ })
    .getByRole('button', { name: 'Turn off for the company' })
    .click();
  await expect(drawer.getByRole('button', { name: 'Turn back on' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Turn back on' }).click();
  await expect(drawer.getByRole('button', { name: 'Turn off for the company' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'History' })).toContainText('Turned back on');
  await page.keyboard.press('Escape');

  await page.goto('/audit?action=rule.turned_off&days=1');
  await expect(page.getByRole('table', { name: 'Audit events' }).locator('tbody tr').first()).toContainText(
    'Priya Shah',
  );
});

test('a biller can open neither settings nor the audit log', async ({ browser }, info) => {
  const biller = await signedInPage(browser, info.project.use, 'marcus@northwind.test');
  for (const path of ['/settings/users', '/audit']) {
    await biller.goto(path);
    await expect(biller.getByText(/You don.t have access/)).toBeVisible();
  }
  await biller.context().close();
});
