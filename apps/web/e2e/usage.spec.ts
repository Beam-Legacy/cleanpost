import { expect, test } from '@playwright/test';
import { expectAccessible, signedInPage } from './helpers';

/** S-11 usage: claims released through Cleanpost per client and mode, by period. */
test('S-11 shows claims released by client and mode, and switches the period', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
  try {
    await page.goto('/settings/usage');
    await expect(page.getByRole('heading', { name: 'Usage and billing', level: 2 })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Claims released', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/A claim counts once, on the day Cleanpost first releases it/)).toBeVisible();
    const periods = page.getByRole('navigation', { name: 'Period' });
    await expect(periods.getByRole('link', { name: 'This month' })).toHaveAttribute('aria-current', 'page');
    await expectAccessible(page, 'S-11');
    await periods.getByRole('link', { name: 'Last 90 days' }).click();
    await expect(page).toHaveURL(/period=last_90/);
    await expect(periods.getByRole('link', { name: 'Last 90 days' })).toHaveAttribute('aria-current', 'page');
  } finally {
    await page.context().close();
  }
});
