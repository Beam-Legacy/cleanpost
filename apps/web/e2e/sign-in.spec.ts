import { expect, test } from '@playwright/test';
import { E2E_EMAIL } from './global-setup';
import { expectAccessible, PASSWORD } from './helpers';
import { totp } from './totp';

test('first sign-in: password, required two-factor setup, company choice, app shell', async ({ page }) => {
  await page.goto('/work');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expectAccessible(page, 'A-01');

  // A-01: a wrong password gets one generic message.
  await page.getByLabel('Work email').fill(E2E_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sign-in-error')).toHaveText('Email or password is incorrect.', {
    timeout: 30_000,
  });

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // A-03: cannot be skipped.
  await expect(page).toHaveURL(/\/setup\/two-factor$/);
  await page.goto('/claims');
  await expect(page).toHaveURL(/\/setup\/two-factor$/);
  await expectAccessible(page, 'A-03 password');
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const key = (await page.locator('code.code').innerText()).trim();
  await expectAccessible(page, 'A-03 scan');
  await page.getByLabel('Code from the app').fill(totp(key));
  await page.getByRole('button', { name: 'Confirm code' }).click();
  await expect(page.getByText('Step 2 of 2 · Recovery codes')).toBeVisible();
  await expect(page.locator('ul.callout li')).toHaveCount(10);
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByLabel('I saved these recovery codes').check();
  await cont.click();

  // A-07: Julia belongs to two companies.
  await expect(page).toHaveURL(/\/choose-company$/);
  await expectAccessible(page, 'A-07');
  await page.getByRole('button', { name: /Northwind Billing/ }).click();

  // G-01 shell and W-01 frame.
  await expect(page).toHaveURL(/\/work$/);
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByText('Admin')).toBeVisible();
  await expect(page.getByText('Northwind Billing').first()).toBeVisible();
  await expectAccessible(page, 'W-01');

  // G-02 client switcher lists only this company's clients.
  await page.getByRole('button', { name: 'All clients' }).click();
  await expect(page.getByRole('option', { name: /Lakeside Family Medicine/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Seaside Physical Therapy/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Lakeside Family Medicine/ }).click();
  await expect(page).toHaveURL(/client=/);

  // G-03 command palette.
  await page.keyboard.press('Control+k');
  await page
    .getByRole('combobox', { name: 'Search or type a command' })
    .or(page.getByLabel('Search or type a command'))
    .fill('rem');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/remittances\?client=/);
  await expect(page.getByRole('button', { name: /Lakeside Family Medicine/ })).toBeVisible();

  await page.screenshot({ path: 'test-results/shell.png', fullPage: true });

  // G-05 sign out → G-10.
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/signed-out\?reason=user$/);
  await expectAccessible(page, 'G-10');

  // A-02: the code is asked at every later sign-in.
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(E2E_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);
  await expectAccessible(page, 'A-02');
  await page.getByLabel('Code').fill(totp(key));
  await expect(page).toHaveURL(/\/(work|choose-company)$/);
});
