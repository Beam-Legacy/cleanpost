import { expect, test } from '@playwright/test';
import { expectAccessible, firstSignIn } from './helpers';

test('admin: clients list and integrations (CL-01, I-01, I-02)', async ({ page }) => {
  await firstSignIn(page, 'priya@northwind.test');

  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
  const table = page.getByRole('table');
  for (const name of [
    'Lakeside Family Medicine',
    'Cascade Pediatrics',
    'Willamette Ortho',
    'Riverbend Counseling',
    'Harbor Dermatology',
  ]) {
    await expect(table.getByText(name)).toBeVisible();
  }
  await expect(table.getByText('Seaside Physical Therapy')).toHaveCount(0); // another company's client
  await expectAccessible(page, 'CL-01');
  await page.getByRole('link', { name: /Onboarding/ }).click();
  await expect(table.getByRole('row')).toHaveCount(2); // header + Harbor Dermatology
  await page.screenshot({ path: 'test-results/clients.png', fullPage: true });

  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await expectAccessible(page, 'I-01');
  await page.getByRole('link', { name: 'Lakeside Family Medicine' }).click();
  await expect(page.getByRole('heading', { name: /Lakeside Family Medicine · Tebra/ })).toBeVisible();
  const ops = page.getByRole('table').first();
  await expect(ops.getByRole('row', { name: /Hold charges/ })).toContainText('Official API');
  await expect(ops.getByRole('row', { name: /Read payments \(835\)/ })).toContainText('File');
  await expect(ops.getByRole('row', { name: /Mark charges billed/ })).toContainText('Not available');
  await expect(ops.getByRole('row', { name: /Post payments/ })).toContainText('Manual');
  await expectAccessible(page, 'I-02');
  await page.screenshot({ path: 'test-results/connection.png', fullPage: true });
});

test('biller: sees only assigned clients and no integrations (G-23)', async ({ page }) => {
  await firstSignIn(page, 'dana@northwind.test');
  await page.goto('/clients');
  await expect(page.getByRole('table').getByText('Lakeside Family Medicine')).toBeVisible();
  await expect(page.getByRole('table').getByText('Harbor Dermatology')).toHaveCount(0); // outside Dana's scope
  await expect(page.getByRole('button', { name: 'Add client' })).toHaveCount(0);
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: "You don't have access to this page" })).toBeVisible();
});
