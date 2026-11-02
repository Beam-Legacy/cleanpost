import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * W-01 Work queue with the W-10 panel, W-06 snooze and W-07 resolve, on the synthetic practices
 * the worker synced from the mock PM. Marcus is a biller on every Northwind client; one sign-in
 * serves the whole file.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
const panel = () => page.locator('aside.panel');
/** The queue is interactive: its keyboard handler is attached. */
async function ready() {
  await expect(page.locator('[data-keys="on"]')).toBeVisible();
}
/** How many J presses reach the first claim review (the chip also lists blocked claims). */
async function pressesToFirstReview() {
  const labels = await page
    .getByRole('table', { name: 'Work items' })
    .locator('tbody tr td:nth-child(3) b')
    .allInnerTexts();
  const i = labels.findIndex((l) => l.trim() === 'Claim review');
  expect(i).toBeGreaterThanOrEqual(0);
  return i + 1;
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { baseURL, viewport } = info.project.use;
  page = await (await browser.newContext({ baseURL, viewport })).newPage();
  await firstSignIn(page, 'marcus@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
});

test('W-01 lists claim reviews with type chips, accessibly', async () => {
  await page.goto('/work?type=review');
  await expect(page.getByRole('table', { name: 'Work items' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Claim review \d+$/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expectAccessible(page, 'W-01');
});

test('a routine claim review takes under 20 seconds from the keyboard, and Undo stops it', async () => {
  await page.goto('/work?type=review');
  await ready();
  // docs/08: a routine claim review in under 20 seconds.
  const presses = await pressesToFirstReview();
  const started = Date.now();
  for (let i = 0; i < presses; i++) await page.keyboard.press('j');
  await expect(panel().getByRole('meter', { name: 'Confidence' })).toBeVisible();
  await expect(panel().getByRole('button', { name: /release/i })).toBeVisible();
  await page.keyboard.press('a');
  await expect(page.getByText('Approved. Releasing in 10 seconds.')).toBeVisible();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(20_000);
  test.info().annotations.push({ type: 'claim review (ms)', description: String(elapsed) });

  // Undo within the 10 seconds: nothing reaches the PM and the claim is back in review.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Approval undone. The claim is back in review.')).toBeVisible();
});

test('W-10 shows findings, lines and why the item is here; Esc closes it', async () => {
  await page.goto('/work?type=review');
  await ready();
  const n = await pressesToFirstReview();
  await page.getByRole('table', { name: 'Work items' }).getByRole('row').nth(n).click();
  await expect(panel().getByText('Findings')).toBeVisible();
  await expect(panel().getByRole('table', { name: 'Claim lines' })).toBeVisible();
  await expect(
    panel().getByText(/^In review because confidence is below this client's threshold of 90/),
  ).toBeVisible();
  await expectAccessible(page, 'W-10');
  await ready();
  await page.keyboard.press('Escape');
  await expect(panel()).toHaveCount(0);
  // Panel closed: the full columns (W-02 layout).
  await expect(page.getByRole('columnheader', { name: 'Reason' })).toBeVisible();
});

test('snooze (W-06) and resolve with a reason (W-07), each with Undo', async () => {
  await page.goto('/work?type=review');
  await ready();
  await page.keyboard.press('j');
  await expect(panel()).toBeVisible();
  const heading = await panel().getByRole('heading', { level: 2 }).innerText();

  await page.keyboard.press('s');
  const snooze = page.getByRole('dialog', { name: 'Snooze until' });
  await expect(snooze).toBeVisible();
  await expectAccessible(page, 'W-06');
  await snooze.getByRole('button', { name: /^Tomorrow 8:00 am/ }).click();
  await expect(page.getByText(/^Snoozed until /)).toBeVisible();
  // The queue moved on to the next item.
  await expect(panel().getByRole('heading', { level: 2 })).not.toHaveText(heading);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Snooze undone.')).toBeVisible();

  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog', { name: 'Resolve item' });
  await expect(dialog.getByRole('button', { name: 'Resolve' })).toBeDisabled();
  await dialog.getByLabel('Other').check();
  await expect(dialog.getByRole('button', { name: 'Resolve' })).toBeDisabled();
  await dialog.getByLabel(/^Note/).fill('Checked with the practice by phone');
  await expectAccessible(page, 'W-07');
  await dialog.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Resolved.')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Item reopened.')).toBeVisible();
});

test('W-04 bulk bar: assign two items (W-05) and confirm a bulk release (C-17)', async () => {
  // Three axe scans of a full queue page.
  test.setTimeout(90_000);
  await page.goto('/work?type=review');
  await ready();
  const rows = page.getByRole('table', { name: 'Work items' }).locator('tbody tr');
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  const bar = page.getByRole('toolbar', { name: 'Selected items' });
  await expect(bar).toContainText('2 selected');
  await expect(bar.getByRole('button', { name: /^Release \d of 2$/ })).toBeVisible();
  await expectAccessible(page, 'W-04');

  await bar.getByRole('button', { name: 'Assign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign 2 items' });
  await expect(dialog.getByRole('list', { name: 'People' })).toContainText('Marcus Lee');
  await expectAccessible(page, 'W-05');
  await dialog.getByRole('button', { name: /^Marcus Lee/ }).click();
  await expect(page.getByText('2 of 2 items assigned.')).toBeVisible();

  // C-17 always confirms first; cancelled here so the synthetic claims stay in review.
  await rows.nth(0).getByRole('checkbox').check();
  const release = page
    .getByRole('toolbar', { name: 'Selected items' })
    .getByRole('button', { name: /^Release/ });
  if (await release.isEnabled()) {
    await release.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('This cannot be undone.');
    await expectAccessible(page, 'C-17');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Selected items' })).toHaveCount(0);
});

test('W-08: saves the current filters as a view, refuses a duplicate name, and removes it', async () => {
  await page.goto('/work?type=review');
  await ready();
  const save = async () => {
    await page.getByRole('button', { name: 'Save view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save view' });
    await expect(dialog).toContainText('Claim review');
    await dialog.getByLabel('Name').fill('My reviews');
    await dialog.getByRole('button', { name: 'Save' }).click();
    return dialog;
  };
  await save();
  await expect(page.getByText('View "My reviews" saved.')).toBeVisible();
  const chip = page.getByRole('link', { name: 'My reviews' });
  await expect(chip).toHaveAttribute('aria-current', 'true');
  const dialog = await save();
  await expect(dialog).toContainText('You already have a view with that name.');
  await expectAccessible(page, 'W-08');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Remove view My reviews' }).click();
  await expect(chip).toHaveCount(0);
});

test('? lists the shortcuts', async () => {
  await page.goto('/work');
  await ready();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});
