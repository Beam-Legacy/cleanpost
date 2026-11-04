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
    await c.query(
      `update clients set status = 'live', pause = null, baseline = null, auto_release_threshold = null,
         review_until = null, primary_biller_id = null, backup_biller_id = null where name = $1`,
      [CLIENT],
    );
    const own = `client_id = (select id from clients where name = $1)`;
    await c.query(`delete from providers where npi = '1234567893' and ${own}`, [CLIENT]);
    await c.query(`delete from locations where name = 'E2E Annex' and ${own}`, [CLIENT]);
    await c.query(`delete from adjustment_mappings where ${own}`, [CLIENT]);
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

const tab = (name: string) =>
  page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name, exact: true }).click();

test('CL-03 sets its own threshold, review everything until a date, and the primary biller', async () => {
  test.setTimeout(90_000);
  await tab('Settings');
  await expect(page.getByRole('heading', { name: 'Automation' })).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'CL-03');
  await page.getByLabel('Its own number').check();
  await page.getByLabel('Release threshold for this client').fill('85');
  await page.getByLabel(/Review everything until a date/).check();
  const until = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Review everything until', { exact: true }).fill(until);
  await page.getByLabel('Primary biller').selectOption({ label: 'Dana Reyes (Biller)' });
  await expect(page.getByText('3 unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved 3 changes/)).toBeVisible();
  await tab('Overview');
  await expect(page.getByText(/Review everything until/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Dana Reyes', { exact: true })).toBeVisible();
});

test('CL-04 checks an NPI before adding a provider, and adds a location', async () => {
  test.setTimeout(90_000);
  await tab('Providers and locations');
  await expect(page.getByRole('table', { name: 'Providers' })).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'CL-04');
  await page.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add provider' });
  await dialog.getByLabel('NPI').fill('1234567890');
  await dialog.getByLabel('Name as billed').fill('Dr. Test Provider');
  await dialog.getByLabel('Taxonomy code').fill('207Q00000X');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog.getByRole('alert')).toContainText('check digit');
  await dialog.getByLabel('NPI').fill('1234567893');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(
    page.getByRole('table', { name: 'Providers' }).getByRole('row', { name: /Dr. Test Provider/ }),
  ).toContainText('1234567893');

  await page.getByRole('button', { name: 'Add location' }).click();
  const loc = page.getByRole('dialog', { name: 'Add location' });
  await loc.getByLabel('Name').fill('E2E Annex');
  await loc.getByLabel('Street').fill('100 Test Street');
  await loc.getByLabel('City').fill('Salem');
  await loc.getByLabel('State').fill('or');
  await loc.getByLabel('ZIP').fill('97301');
  await loc.getByRole('button', { name: 'Add location' }).click();
  await expect(
    page.getByRole('table', { name: 'Locations' }).getByRole('row', { name: /E2E Annex/ }),
  ).toContainText('Salem OR 97301');
});

test('CL-05 sets a timely filing limit; CL-06 maps a code for this client and resets it', async () => {
  test.setTimeout(90_000);
  await tab('Payers');
  const payers = page.getByRole('table', { name: 'Payers' });
  await expect(payers).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'CL-05');
  const first = payers.locator('tbody tr').first();
  const payer = (await first.locator('th').innerText()).trim();
  const before = (await first.locator('td').nth(3).innerText()).match(/\d+/)![0];
  await first.getByRole('button', { name: `Edit timely filing for ${payer}` }).click();
  await first.getByLabel(`Timely filing days for ${payer}`).fill('120');
  await first.getByRole('button', { name: `Save timely filing for ${payer}` }).click();
  await expect(first).toContainText('120 days');
  await first.getByRole('button', { name: `Edit timely filing for ${payer}` }).click();
  await first.getByLabel(`Timely filing days for ${payer}`).fill(before);
  await first.getByRole('button', { name: `Save timely filing for ${payer}` }).click();
  await expect(first).toContainText(`${before} days`);

  await tab('Adjustment mappings');
  const table = page.getByRole('table', { name: /adjustment mappings for this client/ });
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'CL-06');
  const row = table.getByRole('row', { name: /CO-45/ });
  await row.getByRole('button', { name: 'Set for this client CO-45' }).click();
  await row.getByRole('textbox').fill('CONTRX');
  await row.getByRole('button', { name: 'Save CO-45' }).click();
  await expect(row).toContainText('This client');
  await expect(row).toContainText('CONTRX');
  await row.getByRole('button', { name: 'Reset to default CO-45' }).click();
  await expect(row).not.toContainText('This client');
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
