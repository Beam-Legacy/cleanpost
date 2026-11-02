import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * Flow 5 (docs/09): a CO-4 denial on Cascade (made by e2e/fixtures/denial.ts) to a corrected claim:
 * D-02 (W-16's panel) suggests modifier 25, Build correction opens C-09 with the fix and frequency
 * 7, the scrub runs, the claim is released (Mode A: a task to resubmit it from the PM), and the
 * timeline shows the correction. Then D-03 on a CO-197 denial over the $500 approval limit: Lena,
 * a biller on every client, asks for approval; Priya, an admin, approves it in the queue. D-01
 * lists the denials by category; an admin can write off several at once.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let claimUrl = '';
/** The CO-197 denial over the limit (the largest, so first in D-01). */
let authId = '';

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
  await expect(page.getByRole('link', { name: /^Authorization \d+/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Open denials' })).toBeVisible();
  await expectAccessible(page, 'D-01');
});

test('D-02 explains the denial and builds the correction with the fix (C-09)', async () => {
  test.setTimeout(120_000);
  await page.goto('/denials?kind=coding');
  await page.getByRole('table', { name: 'Open denials' }).getByRole('link').first().click();
  await expect(page.getByText(/^Add modifier 25 to line \d \(99213\)$/)).toBeVisible();
  await expectAccessible(page, 'D-02 (W-16 panel)');
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

test('D-02 shows the deadline, similar denials and history; Esc closes it', async () => {
  await page.goto('/denials?kind=authorization');
  await page.getByRole('table', { name: 'Open denials' }).getByRole('link').first().click();
  await expect(page).toHaveURL(/denial=/);
  authId = new URL(page.url()).searchParams.get('denial')!;
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Authorization').first()).toBeVisible();
  await expect(drawer.getByText('Add the prior authorization number')).toBeVisible();
  await expect(drawer.getByText('Corrected claim by')).toBeVisible();
  await expect(drawer.getByText(/^Denied in .* from an uploaded 835$/)).toBeVisible();
  await expect(drawer.getByRole('list', { name: 'Claim history' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Similar denials' })).toBeVisible();
  await expectAccessible(page, 'D-02');
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/denial=/);
});

test('D-03 over the approval limit: the biller asks an admin', async () => {
  await page.goto(`/denials?kind=authorization&denial=${authId}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Write off' }).click();
  const dialog = page.getByRole('dialog', { name: /^Write off \$[\d,]+\.\d\d$/ });
  await expect(dialog.getByText(/^Over your approval limit of \$500\.00/)).toBeVisible();
  const ask = dialog.getByRole('button', { name: 'Request approval' });
  await expect(ask).toBeDisabled(); // a note is needed over $100
  await dialog.getByLabel(/^Note/).fill('The practice asked to write it off');
  await expectAccessible(page, 'D-03');
  await ask.click();
  await expect(page.getByText(/^Sent to an admin for approval/)).toBeVisible();
  await expect(page.getByText(/is waiting for an admin \(asked by Lena Ortiz/)).toBeVisible();
});

test('an admin approves it in the queue and the denial is written off', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { baseURL, viewport } = info.project.use;
  const admin = await (await browser.newContext({ baseURL, viewport })).newPage();
  try {
    await firstSignIn(admin, 'priya@northwind.test');
    await admin.goto('/work?type=denials');
    await admin
      .getByRole('table', { name: 'Work items' })
      .getByRole('row')
      .filter({ hasText: 'Approve a write-off' })
      .first()
      .click();
    const panel = admin.getByRole('complementary', { name: 'Write-off approval' });
    await expect(panel.getByText('Asked by')).toBeVisible();
    await expect(panel.getByText(/^Lena Ortiz,/)).toBeVisible();
    await expectAccessible(admin, 'W-01 write-off approval');
    await panel.getByRole('button', { name: /^Approve and write off \$/ }).click();
    await expect(admin.getByText(/^Approved and written off/)).toBeVisible();

    // D-03 bulk: an admin selects denials of one client and sees the count and total.
    await admin.goto('/denials');
    const table = admin.getByRole('table', { name: 'Open denials' });
    await table
      .getByRole('checkbox', { name: /^Select denial for / })
      .first()
      .check();
    const bar = admin.getByRole('toolbar', { name: 'Selected denials' });
    await expect(bar).toContainText(/^1 selected · \$/);
    await bar.getByRole('button', { name: 'Write off' }).click();
    const bulk = admin.getByRole('dialog', { name: 'Write off 1 denial' });
    await expect(bulk.getByRole('button', { name: /^Write off \$/ })).toBeVisible();
    await expectAccessible(admin, 'D-03 bulk');
    await bulk.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await admin.context().close();
  }
  // The biller sees it gone from the open denials.
  await page.goto('/denials');
  await expect(page.getByRole('heading', { level: 1, name: 'Denials' })).toBeVisible();
  await expect(page.locator(`a[href*="denial=${authId}"]`)).toHaveCount(0);
});
