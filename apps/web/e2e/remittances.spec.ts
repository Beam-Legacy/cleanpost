import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * R-01 Remittances, R-02 Upload 835 and R-04 remittance detail, with synthetic golden 835 files for
 * Lakeside (a Tebra client, whose 835s always arrive as uploads). Lena is a biller on every client.
 */
test.describe.configure({ mode: 'serial' });

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'testing',
  'golden',
  '835',
);
const FILES = ['paid-in-full.edi', 'zero-pay.edi'].map((f) => join(GOLDEN, f));

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

test('R-02 reads 835 files, shows the checks, and imports them once', async () => {
  await page.goto('/remittances');
  await expect(page.getByRole('heading', { level: 1, name: 'Remittances' })).toBeVisible();
  await page.getByRole('button', { name: 'Upload 835' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload 835' });
  await dialog.getByLabel('835 files').setInputFiles(FILES);
  const table = dialog.getByRole('table', { name: 'Payments in the files' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByText('Lakeside Family Medicine').first()).toBeVisible();
  await expectAccessible(page, 'R-02');
  // A retried run finds them imported already; otherwise import and read them again.
  if ((await dialog.getByText(/^Already imported/).count()) === 0) {
    await expect(table.getByText('Balances')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Import 2 payments' }).click();
    await expect(page.getByText(/^Imported 2 payments/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Upload 835' }).click();
    await page.getByRole('dialog', { name: 'Upload 835' }).getByLabel('835 files').setInputFiles(FILES);
  }
  const again = page.getByRole('dialog', { name: 'Upload 835' });
  await expect(again.getByText(/^Already imported/)).toHaveCount(2);
  await expect(again.getByRole('button', { name: 'Import' })).toBeDisabled();
  await again.getByRole('button', { name: 'Cancel' }).click();
});

test('R-01 lists the payments with what each needs, accessibly', async () => {
  await page.goto('/remittances');
  const table = page.getByRole('table', { name: 'Payments' });
  await expect(table.getByText('Lakeside Family Medicine').first()).toBeVisible();
  await expect(table.getByText('Upload').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /^Needs attention \d+/ })).toBeVisible();
  await expectAccessible(page, 'R-01');
});

test('R-04 shows the 835 check and the comparison with the PM', async () => {
  await page.goto('/remittances');
  await page
    .getByRole('table', { name: 'Payments' })
    .getByRole('row')
    .filter({ hasText: 'Upload' })
    .first()
    .getByRole('link')
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('·');
  await expect(page.getByText(/^835 (balances|does not balance)$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /compared with what .* posted/ })).toBeVisible();
  await expectAccessible(page, 'R-04');
});
