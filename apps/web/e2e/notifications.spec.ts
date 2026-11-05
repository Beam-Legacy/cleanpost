import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, signedInPage } from './helpers';

/**
 * G-04 notifications drawer, S-09 notification settings and the A-09 email switches. Priya's
 * notifications are made here (the sweep runs on its own schedule); the settings go back as they were.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
const db = () =>
  new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });

const reset = async () => {
  const c = db();
  await c.connect();
  try {
    const u = `(select id from users where email = 'priya@northwind.test')`;
    await c.query(`delete from notifications where user_id = ${u} and dedupe_key like 'e2e:%'`);
    await c.query(`update notifications set read_at = coalesce(read_at, now()) where user_id = ${u}`);
    await c.query(
      `delete from notification_rules where tenant_id = (select id from tenants where name = 'Northwind Billing')`,
    );
    await c.query(
      `update tenants set settings = settings - 'notifications' where name = 'Northwind Billing'`,
    );
    await c.query(`update user_preferences set digest_email = true, alert_email = true where user_id = ${u}`);
  } finally {
    await c.end();
  }
};

const seedNotifications = async () => {
  const c = db();
  await c.connect();
  try {
    await c.query(`
      insert into notifications (tenant_id, user_id, client_id, type, entity_type, entity_id, summary, detail,
        link, urgent, dedupe_key, created_at)
      select t.id, u.id, cl.id, x.type, 'client', cl.id, x.summary, x.detail, '/clients/' || cl.id, x.urgent,
        'e2e:' || x.type, now() - x.age
      from tenants t, users u, clients cl,
        (values ('connection_failed', 'Riverbend Counseling: SimplePractice connection failed',
                 'New charges and payments are not syncing', true, interval '5 minutes'),
                ('client_live', 'Riverbend Counseling is live', 'First sync completed', false, interval '3 days'))
          as x(type, summary, detail, urgent, age)
      -- Riverbend has no integration, so the sweep never makes alerts like these for it.
      where t.name = 'Northwind Billing' and u.email = 'priya@northwind.test' and cl.name = 'Riverbend Counseling'`);
  } finally {
    await c.end();
  }
};

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await reset();
  await seedNotifications();
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
  await reset();
});

test('G-04 lists notifications by day, opens one and marks it read, and marks all read', async () => {
  test.setTimeout(90_000);
  await page.goto('/work');
  const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toBeVisible({ timeout: 30_000 });
  await bell.click();
  const drawer = page.getByRole('dialog', { name: 'Notifications' });
  await expect(drawer.getByRole('region', { name: 'Today' })).toContainText(
    'Riverbend Counseling: SimplePractice connection failed',
  );
  await expect(drawer.getByRole('region', { name: 'Earlier this week' })).toContainText(
    'Riverbend Counseling is live',
  );
  await drawer.getByRole('button', { name: /^Urgent/ }).click();
  await expect(drawer.getByText('Riverbend Counseling is live')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'All', exact: true }).click();
  await expectAccessible(page, 'G-04');

  // Opening one goes to its record and marks it read.
  await drawer.getByRole('link', { name: /Riverbend Counseling: SimplePractice connection failed/ }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+/);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(
    drawer.getByRole('link', { name: /Riverbend Counseling: SimplePractice connection failed/ }),
  ).not.toContainText('(unread)');
  await drawer.getByRole('button', { name: 'Mark all read' }).click();
  await expect(drawer.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('S-09 sets channels and amounts, keeps admin emails on, and saves with a count', async () => {
  test.setTimeout(60_000);
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  const table = page.getByRole('table', { name: 'Who hears about what' });
  // Admins' connection-failed email cannot be turned off.
  await expect(table.getByLabel('Connection failed: email right away')).toBeDisabled();
  await expect(table.getByLabel('Connection failed: email right away')).toBeChecked();
  await expectAccessible(page, 'S-09');

  await table.getByLabel('Denial amount in dollars').fill('2500');
  await table.getByLabel('Denial: email right away').check();
  await page.getByLabel('Quiet hours (no email)').selectOption('21-07');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved 2 changes.')).toBeVisible();
  await page.reload();
  await expect(table.getByLabel('Denial amount in dollars')).toHaveValue('2500');
  await expect(table.getByLabel('Denial: email right away')).toBeChecked();
  await expect(page.getByLabel('Quiet hours (no email)')).toHaveValue('21-07');
});

test('A-09 lets a person turn their own emails off and on', async () => {
  test.setTimeout(60_000);
  await page.goto('/account#email');
  const digest = page.getByRole('switch', { name: 'Daily digest' });
  await expect(digest).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText('As an admin you still get connection-failed and timely-filing emails.'),
  ).toBeVisible();
  await expect(digest).toBeChecked();
  await digest.click();
  await expect(page.getByText('Email settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Daily digest' })).not.toBeChecked();
  await expectAccessible(page, 'A-09 email');
  await page.getByRole('switch', { name: 'Daily digest' }).click();
  await expect(page.getByRole('switch', { name: 'Daily digest' })).toBeChecked();
});
