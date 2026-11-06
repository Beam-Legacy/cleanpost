import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, signedInPage } from './helpers';

/**
 * W-22 timely filing (made by e2e/fixtures/filing.ts: a claim two days from its filing limit, found
 * by the notification sweep), the C-02 red banner, and the item's ways out.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let itemId: string;
let claimId: string;

async function run<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const c = new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const [row] = await run<{ id: string; claim_id: string }>(
    `select w.id, w.claim_id from work_items w join claims c on c.id = w.claim_id
      where w.type = 'timely_filing_risk' and w.status <> 'resolved'
        and c.status in ('needs_review', 'ready', 'blocked')
      order by c.filing_deadline desc limit 1`,
  );
  expect(row, 'run e2e/fixtures/filing.ts (global setup does)').toBeDefined();
  itemId = row!.id;
  claimId = row!.claim_id;
  // A run that was cut short may have left it assigned or snoozed.
  await run(`update work_items set status = 'open', assignee_id = null, snoozed_until = null where id = $1`, [
    itemId,
  ]);
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
});

test('W-22 shows the time left, where the limit comes from and what holds the claim', async () => {
  test.setTimeout(60_000);
  await page.goto(`/work?item=${itemId}`);
  const panel = page.getByRole('complementary', { name: 'Timely filing' });
  await expect(panel.getByText('2 days left')).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText(/Must reach .+ by .+\./);
  await expect(panel).toContainText(/Filing limit \d+ days from the date of service/);
  await expect(panel.getByRole('link', { name: 'Fix blocker' })).toBeVisible();
  await expect(panel).toContainText('Admins get an email each day until this is resolved.');
  await expectAccessible(page, 'W-22');
});

test('W-22 cannot be snoozed past the filing limit', async () => {
  test.setTimeout(60_000);
  await page.keyboard.press('s');
  const dialog = page.getByRole('dialog', { name: 'Snooze until' });
  await expect(dialog).toBeVisible();
  const later = new Date(Date.now() + 20 * 86_400_000);
  const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await dialog.getByLabel('Pick date and time (Pacific)').fill(local);
  await dialog.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(page.getByText('Not past the filing limit: pick a time on or before that day.')).toBeVisible();
});

test('C-02 shows the red filing banner', async () => {
  test.setTimeout(60_000);
  await page.goto(`/claims/${claimId}`);
  const banner = page.getByText('Filing deadline in 2 days.');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.banner.bad')).toContainText('Filing deadline in 2 days.');
});

test('W-22 escalates to an admin, and saving proof of timely filing resolves it', async () => {
  test.setTimeout(60_000);
  await page.goto(`/work?item=${itemId}`);
  const panel = page.getByRole('complementary', { name: 'Timely filing' });
  await expect(panel.getByRole('button', { name: 'Escalate to admin' })).toBeVisible({ timeout: 30_000 });
  await panel.getByLabel('Admin').selectOption({ label: 'Julia Beam' });
  await panel.getByRole('button', { name: 'Escalate to admin' }).click();
  await expect(page.getByText('Escalated. The admin was told right away.')).toBeVisible();
  const [note] = await run<{ urgent: boolean; link: string }>(
    `select n.urgent, n.link from notifications n join users u on u.id = n.user_id
      where u.email = 'julia@northwind.test' and n.entity_id = $1 and n.type = 'work_item.escalated'`,
    [itemId],
  );
  expect(note).toEqual({ urgent: true, link: `/work?item=${itemId}` });

  await panel.getByLabel('Clearinghouse report or payer letter').setInputFiles({
    name: 'acceptance.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% e2e proof\n'),
  });
  await panel.getByRole('button', { name: 'Save proof' }).click();
  await expect(page.getByText('Proof saved and the item resolved.')).toBeVisible();
  const [item] = await run<{ status: string; resolution: string; type: string }>(
    `select w.status, w.resolution, d.type from work_items w join documents d on d.id = w.document_id where w.id = $1`,
    [itemId],
  );
  expect(item).toEqual({
    status: 'resolved',
    resolution: 'Documented with payer: Proof of timely filing uploaded.',
    type: 'timely_filing_proof',
  });
});
