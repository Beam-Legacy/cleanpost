import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** TOTP keys set up during this run, so a retried spec can sign the same user in again. */
const KEYS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', '.e2e-keys');
const keyFile = (email: string) => join(KEYS, email.replace(/[^a-z0-9.@-]/gi, '_'));

/**
 * First sign-in for a reset user: password, real TOTP setup, recovery codes; lands on /work or the
 * company chooser. On a retry the user already has two-factor from the first attempt, so the key
 * saved then is used to sign in with a code instead.
 */
export async function firstSignIn(page: Page, email: string): Promise<string> {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Generous: the dev server compiles the auth route on first use.
  await expect(page).toHaveURL(/\/(setup\/two-factor|sign-in\/verify)$/, { timeout: 30_000 });
  let key: string;
  if (page.url().endsWith('/sign-in/verify') && existsSync(keyFile(email))) {
    key = readFileSync(keyFile(email), 'utf8').trim();
    await page.getByLabel('Code').fill(totp(key));
  } else {
    await expect(page).toHaveURL(/\/setup\/two-factor$/);
    await page.getByLabel('Your password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    key = (await page.locator('code.code').innerText()).trim();
    mkdirSync(KEYS, { recursive: true });
    writeFileSync(keyFile(email), key);
    await page.getByLabel('Code from the app').fill(totp(key));
    await page.getByRole('button', { name: 'Confirm code' }).click();
    await page.getByLabel('I saved these recovery codes').check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  // The URL can show /work for a moment before the app moves a user without a company to A-07;
  // wait for a page that is settled: Work, or the chooser for people in several companies.
  await expect(page.getByRole('heading', { level: 1, name: /^(Work|Choose a company)$/ })).toBeVisible({
    timeout: 30_000,
  });
  return key;
}

const stateFile = (email: string) => `${keyFile(email)}.state.json`;

/**
 * A page signed in as this user in a new context. The first spec that needs the user signs in
 * (firstSignIn) and saves the session; later specs reuse it, so a run stays under the sign-in rate
 * limit (10 a minute, packages/auth). The saved sessions live in test-results, cleared every run.
 */
export async function signedInPage(
  browser: Browser,
  use: { baseURL?: string | undefined; viewport?: { width: number; height: number } | null | undefined },
  email: string,
): Promise<Page> {
  const opts = { baseURL: use.baseURL, viewport: use.viewport ?? null };
  const file = stateFile(email);
  if (existsSync(file)) {
    const ctx = await browser.newContext({ ...opts, storageState: file });
    const page = await ctx.newPage();
    await page.goto('/work');
    try {
      await page
        .getByRole('heading', { level: 1, name: /^(Work|Choose a company)$/ })
        .waitFor({ state: 'visible', timeout: 20_000 });
      return page;
    } catch {
      await ctx.close();
    }
  }
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await firstSignIn(page, email);
  mkdirSync(KEYS, { recursive: true });
  await ctx.storageState({ path: file });
  return page;
}
