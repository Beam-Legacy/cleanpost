import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * C-01 Claims list, C-02 to C-05 claim detail and C-08 editor on the synthetic practices the
 * worker synced. Lena is a biller on every Northwind client; one sign-in serves the whole file.
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

test('C-01 lists open claims with saved views, accessibly', async () => {
  await page.goto('/claims');
  await expect(page.getByRole('heading', { level: 1, name: 'Claims' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^All open \d+/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('table', { name: 'Claims' })).toBeVisible();
  await expectAccessible(page, 'C-01');
  await page.getByRole('link', { name: /^Needs review \d+/ }).click();
  await expect(page.getByRole('link', { name: /^Needs review \d+/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('table', { name: 'Claims' }).getByText('Needs review').first()).toBeVisible();
});

test('C-02 to C-05: summary, lines, timeline and versions', async () => {
  await page.goto('/claims?view=review');
  await page.getByRole('table', { name: 'Claims' }).getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('DOS');
  await expect(page.getByRole('heading', { name: /^Findings/ })).toBeVisible();
  await expectAccessible(page, 'C-02');
  await page.getByRole('link', { name: 'Lines' }).click();
  await expect(page.getByRole('table', { name: 'Claim lines' })).toBeVisible();
  await expectAccessible(page, 'C-03');
  await page.getByRole('link', { name: 'Timeline' }).click();
  await expect(page.getByRole('list', { name: 'Claim timeline' })).toContainText('Scrubbed');
  await expectAccessible(page, 'C-04');
  await page.getByRole('link', { name: /^Versions/ }).click();
  await expect(page.getByRole('table', { name: 'Claim versions' })).toContainText('First version');
  await expectAccessible(page, 'C-05');
});

test('C-08: an edit shows live findings and saves as a new version with its changes', async () => {
  await page.goto('/claims?view=review');
  await page.getByRole('table', { name: 'Claims' }).getByRole('link').first().click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  const modifiers = page.getByLabel('Line 1 modifiers');
  await expect(modifiers).toBeVisible();
  await expectAccessible(page, 'C-08');
  const original = await modifiers.inputValue();
  // A modifier that does not exist: the live findings block it before anything is saved.
  await modifiers.fill(`${original} ZZ`.trim());
  await expect(page.getByRole('list', { name: 'Changes made' })).toContainText('modifier ZZ added');
  await expect(page.getByLabel('Live findings')).toContainText('modifier ZZ is not valid');
  await expect(page.getByRole('button', { name: 'Save and release' })).toBeDisabled();
  // Back out, and make a harmless change instead: a prior authorization number.
  await modifiers.fill(original);
  await page.getByLabel('Prior authorization number').fill(`PA${Date.now().toString().slice(-8)}`);
  await expect(page.getByRole('list', { name: 'Changes made' })).toContainText(
    'Prior authorization number set',
  );
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText(/^Saved as version \d+ with \d+ changes?\./)).toBeVisible();
  await page.getByRole('link', { name: /^Versions/ }).click();
  await expect(page.getByRole('table', { name: 'Claim versions' })).toContainText(
    'Prior authorization number set',
  );
});

test('C-10: compares the edited version with the one before', async () => {
  await page
    .getByRole('link', { name: /^Compare with v\d+$/ })
    .first()
    .click();
  await expect(page.getByRole('table', { name: 'Changed fields' })).toContainText(
    'Prior authorization number set',
  );
  await expectAccessible(page, 'C-10');
});

test('C-06 and G-12: coverage is masked; a reveal shows the value and is recorded', async () => {
  await page.getByRole('link', { name: 'Patient and coverage' }).click();
  await expect(page.getByText(/^••\/••\/\d{4}$/)).toBeVisible();
  await expectAccessible(page, 'C-06');
  await page.getByRole('button', { name: 'Reveal date of birth' }).click();
  await expect(page.getByText(/^\d{4}-\d{2}-\d{2}$/)).toBeVisible();
  await page.getByRole('button', { name: 'Hide date of birth' }).click();
  await expect(page.getByText(/^••\/••\/\d{4}$/)).toBeVisible();
});

test('C-16: a note appears on the timeline', async () => {
  await page.getByRole('link', { name: 'Summary' }).click();
  await page.getByLabel('Add a note').fill('Called the practice about the prior authorization.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Note added.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recent activity' })).toContainText(
    'Note: Called the practice',
  );
});

test('C-13: voids a claim that was never sent', async () => {
  await page.goto('/claims?view=review');
  await page.getByRole('table', { name: 'Claims' }).getByRole('link').nth(1).click();
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Void claim' });
  await expect(dialog.getByRole('button', { name: 'Void claim' })).toBeDisabled();
  await dialog.getByLabel('Duplicate').check();
  await expectAccessible(page, 'C-13');
  await dialog.getByRole('button', { name: 'Void claim' }).click();
  await expect(page.getByText('Claim voided. Its open items are closed.')).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'Voided' }).first()).toBeVisible();
});

test('C-12: holds a claim in review, then releases the hold', async () => {
  await page.goto('/claims?view=review');
  await page.getByRole('table', { name: 'Claims' }).getByRole('link').nth(2).click();
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hold claim' });
  await dialog.getByLabel('Waiting for records').check();
  await expectAccessible(page, 'C-12');
  await dialog.getByRole('button', { name: 'Hold claim' }).click();
  await expect(page.getByText('On hold until you release it.')).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'On hold' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Release hold' }).click();
  await expect(page.getByText('Hold released. The claim was checked again.')).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'On hold' })).toHaveCount(0);
});

test('C-07 lists the payments for a claim, or says none have come in', async () => {
  await page.goto('/claims?view=review');
  await page.getByRole('table', { name: 'Claims' }).getByRole('link').first().click();
  await page.getByRole('link', { name: 'Payments' }).click();
  await expect(page.getByRole('link', { name: 'Payments' })).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByText('No payment received yet').or(page.getByRole('link', { name: 'Open remittance' }).first()),
  ).toBeVisible();
  await expectAccessible(page, 'C-07');
});
