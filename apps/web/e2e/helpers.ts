import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { totp } from './totp';

export const PASSWORD = process.env.SEED_PASSWORD ?? 'cleanpost-dev-password';

/** Runs axe (WCAG 2.2 AA) in light and dark themes. */
export async function expectAccessible(page: Page, label: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      violations.map(
        (v) => `${label} (${theme}) ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([]);
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** First sign-in for a reset user: password, real TOTP setup, recovery codes; lands on /work or the company chooser. */
export async function firstSignIn(page: Page, email: string): Promise<string> {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Generous: the dev server compiles the auth route on first use.
  await expect(page).toHaveURL(/\/setup\/two-factor$/, { timeout: 30_000 });
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  const key = (await page.locator('code.code').innerText()).trim();
  await page.getByLabel('Code from the app').fill(totp(key));
  await page.getByRole('button', { name: 'Confirm code' }).click();
  await page.getByLabel('I saved these recovery codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  // The URL can show /work for a moment before the app moves a user without a company to A-07;
  // wait for a page that is settled: Work, or the chooser for people in several companies.
  await expect(page.getByRole('heading', { level: 1, name: /^(Work|Choose a company)$/ })).toBeVisible({
    timeout: 30_000,
  });
  return key;
}
