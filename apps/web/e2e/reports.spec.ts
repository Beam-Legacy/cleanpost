import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signedInPage } from './helpers';

/**
 * RP-01 to RP-07 and F-01 on the synthetic practices: figures are whatever the synced claims and
 * the e2e fixtures produce, so this checks what each report shows, not its numbers. Priya is an
 * admin (the Team report is admin-only).
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

test('RP-01 shows the KPIs with their definitions (RP-07), a chart with a table view, and every client', async () => {
  test.setTimeout(90_000);
  await page.goto('/reports?period=last_90');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  const kpis = page.getByRole('region', { name: 'Key figures' });
  await expect(kpis.getByText('First-pass acceptance')).toBeVisible();
  await kpis.getByRole('button', { name: 'How days in a/r is calculated' }).click();
  const popover = page.getByRole('dialog', { name: 'How days in a/r is calculated' });
  await expect(popover).toContainText('Open insurance A/R ÷ average daily charges (last 90 days)');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await page.getByRole('group', { name: 'First-pass acceptance by week: view' }).getByText('Table').click();
  await expect(page.getByRole('table', { name: 'First-pass acceptance by week' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Results by client' })).toContainText(
    'Lakeside Family Medicine',
  );
  await expectAccessible(page, 'RP-01');
});

test('RP-02 is one client with its payers, aging and denial reasons; F-01 is the practice’s PDF', async () => {
  test.setTimeout(90_000);
  await page.goto('/reports?period=last_90');
  await page
    .getByRole('table', { name: 'Results by client' })
    .getByRole('link', { name: 'Willamette Ortho' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Willamette Ortho' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By payer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top denial reasons' })).toBeVisible();
  await expectAccessible(page, 'RP-02');

  await page.getByRole('link', { name: 'Practice report (PDF)' }).click();
  const doc = page.getByRole('article', { name: 'Revenue cycle report for Willamette Ortho' });
  await expect(doc).toContainText('Northwind Billing');
  await expect(doc).toContainText('Contains no patient-level information');
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  await expectAccessible(page, 'F-01');
});

test('RP-03 ages open balances by payer, or by client', async () => {
  test.setTimeout(90_000);
  await page.goto('/reports/aging');
  await expect(page.getByRole('heading', { level: 1, name: 'A/R aging' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '91–120' })).toBeVisible();
  await page.getByRole('link', { name: 'By client' }).click();
  await expect(page.getByRole('columnheader', { name: 'Client' })).toBeVisible();
  await expectAccessible(page, 'RP-03');
});

test('RP-04 lists the denial codes in plain words; RP-05 shows each biller’s workload', async () => {
  test.setTimeout(90_000);
  await page.goto('/reports/denials?period=last_90');
  await expect(page.getByRole('heading', { level: 1, name: 'Denials report' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Top denial codes' })).toBeVisible();
  await expectAccessible(page, 'RP-04');
  await page.goto('/reports/team?period=last_90');
  await expect(page.getByRole('table', { name: 'Work by biller' })).toContainText('Marcus');
  await expectAccessible(page, 'RP-05');
});

test('RP-06 exports CSV with the metric definitions as comment lines', async () => {
  const res = await page.request.get('/reports/export?report=overview&period=last_90');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  const lines = (await res.text()).split('\r\n');
  expect(lines[0]).toMatch(/^# Reports overview, /);
  expect(lines).toContain(
    'Client,Mode,Claims,Charges ($),Collections ($),First-pass acceptance (%),Denial rate (%),Days in A/R,Released without review (%),Open items',
  );
});
