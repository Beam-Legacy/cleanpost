import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * C-15 and W-15 (docs/09): a claim the payer accepted a month ago with no payment has a follow-up
 * in the queue (made by e2e/fixtures/status.ts with a status answer: pended for records). The panel
 * shows how long it has waited and the answer in plain words; Create task opens the records
 * request; the claim's status drawer shows the codes. Lena is a biller on every client.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { baseURL, viewport } = info.project.use;
  page = await (await browser.newContext({ baseURL, viewport })).newPage();
  await firstSignIn(page, 'lena@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
});

test('W-15 shows the follow-up with the payer’s answer and creates the records task', async () => {
  test.setTimeout(90_000);
  await page.goto('/work?type=other');
  await page
    .getByRole('table', { name: 'Work items' })
    .getByRole('row')
    .filter({ hasText: /No payment \d+ days after/ })
    .first()
    .click();
  const panel = page.getByRole('complementary', { name: 'No response' });
  await expect(panel.getByText('Pended: waiting for medical records.')).toBeVisible();
  await expect(panel.getByText('Days waiting')).toBeVisible();
  await expect(panel.getByText(/^Ask the practice for the visit note/)).toBeVisible();
  await expectAccessible(page, 'W-15');
  // The fixture runs once per database: on a rerun the task is already open.
  const create = panel.getByRole('button', { name: 'Create records request task' });
  if (await create.count()) {
    await create.click();
    await expect(page.getByText(/^Task created: Send the visit note to /)).toBeVisible();
  }
  await expect(create).toHaveCount(0);
});

test('C-15 shows the status check on the claim with its codes', async () => {
  const panel = page.getByRole('complementary', { name: 'No response' });
  await panel.getByRole('link', { name: 'Status details' }).click();
  const drawer = page.getByRole('dialog', { name: 'Status check' });
  await expect(drawer.getByText('Pended: waiting for medical records.')).toBeVisible();
  await expect(drawer.getByText('P3', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Missing or invalid information')).toBeVisible();
  await expect(drawer.getByText(/^Next automatic check: /)).toBeVisible();
  await expectAccessible(page, 'C-15');
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/status=last/);
  await expect(page.getByRole('link', { name: 'Status details' })).toBeVisible();
});
