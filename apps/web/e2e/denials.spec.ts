import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * Flow 5 (docs/09): a CO-4 denial on Cascade (made by e2e/fixtures/denial.ts) to a corrected claim:
 * W-16 suggests modifier 25, Build correction opens C-09 with the fix and frequency 7, the scrub
 * runs, the claim is released (Mode A: a task to resubmit it from the PM), and the timeline shows
 * the correction. D-01 lists the denial by category. Lena is a biller on every client.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let claimUrl = '';

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { baseURL, viewport } = info.project.use;
  page = await (await browser.newContext({ baseURL, viewport })).newPage();
  await firstSignIn(page, 'lena@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
});

test('D-01 shows open denials by category, accessibly', async () => {
  await page.goto('/denials');
  await expect(page.getByRole('heading', { level: 1, name: 'Denials' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Coding \d+/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Open denials' })).toBeVisible();
  await expectAccessible(page, 'D-01');
});

test('W-16 explains the denial and builds the correction with the fix (C-09)', async () => {
  test.setTimeout(120_000);
  await page.goto('/denials?kind=coding');
  await page.getByRole('table', { name: 'Open denials' }).getByRole('link').first().click();
  await expect(page.getByText(/^Add modifier 25 to line \d \(99213\)$/)).toBeVisible();
  await expectAccessible(page, 'W-16');
  await page.getByRole('button', { name: 'Build correction with this fix' }).click();
  await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?edit=1$/, { timeout: 30_000 });
  claimUrl = page.url().replace('?edit=1', '');
  await expect(page.getByText('Corrected claim.')).toBeVisible();
});

test('the corrected claim is checked, released, and on the timeline', async () => {
  test.setTimeout(180_000);
  // The worker scrubs the new version; then it can be released.
  await expect(async () => {
    await page.goto(claimUrl);
    await expect(page.getByRole('button', { name: /^(Approve and release|Release)$/ })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 120_000 });
  await page.getByRole('button', { name: /^(Approve and release|Release)$/ }).click();
  await expect(page.getByRole('status').or(page.getByRole('alert')).first()).toBeVisible();
  await page.goto(`${claimUrl}?tab=timeline`);
  await expect(
    page.getByText(/Corrected claim built \(frequency 7, replaces payer claim PCN-E2E/),
  ).toBeVisible();
  await expectAccessible(page, 'C-09 timeline');
});
