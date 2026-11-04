import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, signedInPage } from './helpers';

/**
 * CL-02 client overview, the onboarding baseline, CL-08 pause and resume, CL-07 activity. Uses
 * Riverbend Counseling and puts it back as it was (live, no baseline).
 */
test.describe.configure({ mode: 'serial' });

const CLIENT = 'Riverbend Counseling';
let page: Page;

const reset = async () => {
  const c = new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });
  await c.connect();
  try {
    await c.query(`update clients set status = 'live', pause = null, baseline = null where name = $1`, [
      CLIENT,
    ]);
  } finally {
    await c.end();
  }
};

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await reset();
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
  await reset();
});

test('CL-02 shows the month against a recorded baseline, open items and the team', async () => {
  test.setTimeout(90_000);
  await page.goto('/clients');
  await page.getByRole('link', { name: CLIENT }).click();
  // Generous: the dev server compiles the client pages on first use.
  await expect(page.getByRole('heading', { level: 1, name: CLIENT })).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Overview' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No baseline was recorded')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team and setup' })).toBeVisible();
  await expectAccessible(page, 'CL-02');

  await page.getByRole('button', { name: 'Record the baseline' }).click();
  const dialog = page.getByRole('dialog', { name: 'Onboarding baseline' });
  await dialog.getByLabel('Collections in a typical month ($)').fill('50000');
  await dialog.getByLabel('First-pass acceptance (%)').fill('85');
  await dialog.getByLabel('Denial rate (%)').fill('10');
  await dialog.getByLabel('Days in A/R').fill('40');
  await dialog.getByLabel('Where the figures came from').fill('Practice PM reports, first half of 2026');
  await dialog.getByRole('button', { name: 'Save baseline' }).click();
  await expect(page.getByText(/Compared with the baseline recorded/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Month to date' })).toContainText('Baseline 85.0%');
  await expect(page.getByRole('region', { name: 'Month to date' })).toContainText('Baseline 40');
});

test('CL-08 pauses the client (releases wait) and resumes it; CL-07 shows both', async () => {
  test.setTimeout(90_000);
  await page.getByRole('button', { name: 'Pause client' }).click();
  const dialog = page.getByRole('dialog', { name: `Pause ${CLIENT}?` });
  await expectAccessible(page, 'CL-08');
  await dialog.getByLabel('Reason').selectOption('Setup problem to fix first');
  await dialog.getByRole('button', { name: 'Pause client' }).click();
  await expect(page.getByText(/Paused since .*: setup problem to fix first/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Client sections' })
    .getByRole('link', { name: 'Activity' })
    .click();
  const activity = page.getByRole('table', { name: 'Client activity' });
  await expect(activity.locator('tbody tr').first()).toContainText('Client: paused');
  await expect(activity).toContainText('Client: recorded the baseline');
  await expectAccessible(page, 'CL-07');

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText(/Paused since/)).toHaveCount(0);
  await expect(activity.locator('tbody tr').first()).toContainText('Client: resumed');
});

test('a biller sees the overview but cannot pause the client or record a baseline', async ({
  browser,
}, info) => {
  const biller = await signedInPage(browser, info.project.use, 'marcus@northwind.test');
  await biller.goto('/clients');
  await biller.getByRole('link', { name: CLIENT }).click();
  await expect(biller.getByRole('heading', { level: 1, name: CLIENT })).toBeVisible({ timeout: 30_000 });
  await expect(biller.getByRole('button', { name: 'Pause client' })).toHaveCount(0);
  await expect(biller.getByRole('button', { name: /baseline/ })).toHaveCount(0);
  await biller.context().close();
});
