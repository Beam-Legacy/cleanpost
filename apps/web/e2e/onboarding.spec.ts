import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, firstSignIn } from './helpers';

/**
 * O-01 to O-11: a new practice from nothing to live, against the mock PM (Tebra limits) and the
 * worker (connection test, dry run, first sync). Runs in Harbor RCM as Julia, in a session of its
 * own, so the claims it builds stay out of Northwind's queue. Earlier runs' practices are
 * offboarded first.
 */
test.describe.configure({ mode: 'serial' });

const PREFIX = 'E2E Onboarding';
const NAME = `${PREFIX} ${Date.now().toString(36).slice(-5)}`;
let page: Page;

const tidy = async () => {
  const c = new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });
  await c.connect();
  try {
    // Test cleanup only: earlier runs' practices leave the lists and the sync schedule.
    await c.query(
      `update connections set status = 'paused' where client_id in (select id from clients where name like $1)`,
      [`${PREFIX}%`],
    );
    await c.query(
      `update clients set status = 'offboarded', offboarded_at = now() where name like $1 and status <> 'offboarded'`,
      [`${PREFIX}%`],
    );
  } finally {
    await c.end();
  }
};

const step = (n: number) => expect(page.getByText(`Step ${n} of 10`)).toBeVisible({ timeout: 30_000 });

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await tidy();
  const ctx = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: info.project.use.viewport ?? null,
  });
  page = await ctx.newPage();
  await firstSignIn(page, 'julia@northwind.test');
  if (!page.url().endsWith('/choose-company')) await page.goto('/choose-company');
  await page.getByRole('button', { name: /Harbor RCM/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await page.context().close();
});

test('O-01 to O-03: practice, providers and locations, PM', async () => {
  test.setTimeout(120_000);
  await page.goto('/clients');
  await page.getByRole('link', { name: 'Add client' }).click();
  await step(1);
  await expectAccessible(page, 'O-01');
  await page.getByLabel('Billing NPI').fill('1234567890');
  await expect(page.getByText('This NPI fails its check digit')).toBeVisible();
  await page.getByLabel('Billing NPI').fill('1234567893');
  await expect(page.getByText('Passes its check digit')).toBeVisible();
  await page.getByLabel('Practice name').fill(NAME);
  await page.getByLabel('Tax ID (EIN)').fill('93-1234567');
  await page.getByLabel('Taxonomy').fill('207Q00000X');
  await page.getByLabel('Billing street address').fill('200 Synthetic Ave');
  await page.getByLabel('City').fill('Salem');
  await page.getByLabel('State').fill('OR');
  await page.getByLabel('ZIP').fill('97301');
  await page.getByLabel('Practice billing contact').fill('Renee Walsh, office manager');
  await page.getByRole('button', { name: 'Continue' }).click();

  await step(2);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('button', { name: 'Add provider' }).click();
  const pv = page.getByRole('dialog', { name: 'Add provider' });
  await pv.getByLabel('NPI').fill('1234567802');
  await pv.getByLabel('Name as billed').fill('Dr. Avery Synth');
  await pv.getByLabel('Taxonomy code').fill('207Q00000X');
  await pv.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByRole('table', { name: 'Providers' }).getByText('Dr. Avery Synth')).toBeVisible();
  await page.getByRole('button', { name: 'Add location' }).click();
  const lc = page.getByRole('dialog', { name: 'Add location' });
  await lc.getByLabel('Name').fill('Salem clinic');
  await lc.getByLabel('Street').fill('200 Synthetic Ave');
  await lc.getByLabel('City').fill('Salem');
  await lc.getByLabel('State').fill('OR');
  await lc.getByLabel('ZIP').fill('97301');
  await lc.getByLabel('Place of service').fill('11');
  await lc.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByRole('table', { name: 'Locations' }).getByText('Salem clinic')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await step(3);
  await expect(page.getByRole('heading', { name: `Which PM system does ${NAME} use?` })).toBeVisible();
  await expectAccessible(page, 'O-03');
  await page.getByRole('radio', { name: /^Tebra/ }).click();
  await page.getByRole('button', { name: 'Continue with Tebra' }).click();
  await step(4);
});

test('O-04 and O-05: connect, test, dry run and spot check', async () => {
  test.setTimeout(240_000);
  await page.getByRole('button', { name: 'Connect and test' }).click();
  // The practice is made in the mock PM, then the worker runs the health check.
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Hold charges')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await step(5);
  await page.getByRole('button', { name: 'Run the dry run' }).click();
  const samples = page.getByRole('table', { name: 'Sample encounters' });
  await expect(samples).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('group', { name: 'Dry run counts' })).toContainText('Encounters');
  await expectAccessible(page, 'O-05');
  const boxes = samples.getByRole('checkbox');
  const n = await boxes.count();
  expect(n).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await step(6);
});

test('O-06 to O-09: payers, mode, posting rules, automation', async () => {
  test.setTimeout(120_000);
  const table = page.getByRole('table', { name: 'Payer matches' });
  await expect(table.getByRole('cell', { name: 'AETNA', exact: true })).toBeVisible();
  // Names the PM uses that no payer name or alias matches need a person to choose.
  const choose = async (pmName: string, payer: string) => {
    const select = page.getByLabel(`Payer for ${pmName}`);
    if (!(await select.count())) return;
    const value = await select.locator('option', { hasText: payer }).first().getAttribute('value');
    await select.selectOption(value!);
  };
  await choose('MEDICARE PART B', 'Medicare (Noridian JF)');
  await choose('PROV HLTH PLN', 'Providence Health Plan');
  await expectAccessible(page, 'O-06');
  await page.getByRole('button', { name: 'Continue' }).click();

  await step(7);
  await expect(page.getByRole('radio', { name: /^Mode A/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: /^Mode B/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Continue with Mode A' }).click();

  await step(8);
  await expect(page.getByText('No unmapped codes.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await step(9);
  await expect(page.getByRole('radio', { name: /^Review everything for 2 weeks/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expectAccessible(page, 'O-09');
  await page.getByRole('button', { name: 'Continue' }).click();
  await step(10);
});

test('O-10 and O-11: checklist, billers, go live, first sync', async () => {
  test.setTimeout(240_000);
  await expect(page.getByText('2 items left')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go live' })).toBeDisabled();
  const primary = page.getByLabel('Primary biller');
  await primary.selectOption({ index: 1 });
  await page.getByLabel('Backup biller').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save billers' }).click();
  await expect(page.getByText('1 item left')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('The practice knows Cleanpost starts today').check();
  await expect(page.getByRole('button', { name: 'Go live' })).toBeEnabled({ timeout: 15_000 });
  await expectAccessible(page, 'O-10');
  await page.getByRole('button', { name: 'Go live' }).click();

  await expect(page.getByRole('heading', { level: 1, name: `${NAME} is live` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+\/live$/);
  await expect(page.getByText('First sync finished')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/encounters? and \d+ patients? pulled from Tebra/)).toBeVisible();
  await expectAccessible(page, 'O-11');

  // The client is live in the list, and its overview opens normally.
  await page.getByRole('link', { name: 'Client overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible({ timeout: 30_000 });
});
