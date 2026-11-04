import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signedInPage } from './helpers';

/**
 * Settings (S-01 and on) and the audit log (S-13). Priya is an admin; Marcus, a biller, may open
 * neither.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
});

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

test('a biller can open neither settings nor the audit log', async ({ browser }, info) => {
  const biller = await signedInPage(browser, info.project.use, 'marcus@northwind.test');
  for (const path of ['/settings/users', '/audit']) {
    await biller.goto(path);
    await expect(biller.getByText(/You don.t have access/)).toBeVisible();
  }
  await biller.context().close();
});
