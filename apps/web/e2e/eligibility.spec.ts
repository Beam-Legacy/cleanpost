import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, signedInPage } from './helpers';

/**
 * W-13 eligibility issue (made by e2e/fixtures/eligibility.ts), P-02 coverage correction and P-06
 * patient details (DEC-30): saved in Cleanpost with a task for the PM. The corrections are undone
 * afterwards so other specs see the world as it was.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let itemId: string;
let patientId: string;
let coverageId: string;

const db = () =>
  new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });

async function run<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const c = db();
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** Puts the coverage and patient back as the PM has them, and removes the tasks this spec made. */
async function undo() {
  if (!patientId) return;
  await run(
    `update coverages c set group_number = (k.before #>> '{}'), source = 'pm'
       from corrections k
      where k.entity_id = c.id and k.field_path = 'coverage.groupNumber' and c.patient_id = $1`,
    [patientId],
  );
  await run(
    `update patients p set phone = (k.before #>> '{}'), source = 'pm'
       from corrections k
      where k.entity_id = p.id and k.field_path = 'patient.phone' and p.id = $1`,
    [patientId],
  );
  await run(`update coverages set source = 'pm' where patient_id = $1`, [patientId]);
  await run(`update patients set source = 'pm' where id = $1`, [patientId]);
  await run(
    `delete from corrections where entity_id = $1 or entity_id in (select id from coverages where patient_id = $1)`,
    [patientId],
  );
  await run(
    `delete from manual_tasks where work_item_id in
       (select id from work_items where patient_id = $1 and type = 'manual_task')`,
    [patientId],
  );
  await run(`delete from work_items where patient_id = $1 and type = 'manual_task'`, [patientId]);
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const [row] = await run<{ id: string; patient_id: string; coverage_id: string }>(
    `select w.id, c.patient_id, c.coverage_id from work_items w
       join claims c on c.id = w.claim_id
       join eligibility_checks k on k.coverage_id = c.coverage_id
      where w.type = 'eligibility_issue' and w.status <> 'resolved' and k.summary->>'fixture' = 'e2e-eligibility'
      limit 1`,
  );
  expect(row, 'run e2e/fixtures/eligibility.ts (global setup does)').toBeDefined();
  itemId = row!.id;
  patientId = row!.patient_id;
  coverageId = row!.coverage_id;
  await undo();
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
  await undo();
});

test('W-13 shows the coverage the payer did not confirm and the ways out', async () => {
  test.setTimeout(60_000);
  await page.goto(`/work?item=${itemId}`);
  const panel = page.getByRole('complementary', { name: 'Eligibility' });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText('The payer reports the coverage inactive on the date of service.');
  const coverage = panel.getByRole('list', { name: 'Coverage' });
  await expect(coverage.getByRole('listitem').first()).toContainText('this claim');
  await expect(coverage).toContainText('Inactive');
  for (const name of ['Check again', 'Update coverage', 'Mark self-pay'])
    await expect(panel.getByRole('button', { name })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open patient' })).toBeVisible();
  await expectAccessible(page, 'W-13');
});

test('P-02 saves a coverage correction in Cleanpost and puts a task for the PM in the queue', async () => {
  test.setTimeout(60_000);
  const panel = page.getByRole('complementary', { name: 'Eligibility' });
  await panel.getByRole('button', { name: 'Update coverage' }).click();
  const dialog = page.getByRole('dialog', { name: /^Edit .+ coverage$/ });
  await expect(dialog).toContainText(
    'cannot be updated from Cleanpost yet. Saving creates a task to update coverage',
  );
  await expect(dialog.getByLabel('Member ID')).toHaveValue('');
  await expectAccessible(page, 'P-02');
  await dialog.getByLabel('Group number').fill('E2E-GRP-1');
  await dialog.getByLabel('Check eligibility after saving').uncheck();
  await dialog.getByRole('button', { name: 'Save coverage' }).click();
  await expect(page.getByText(/^Coverage saved\. A task to update .+ is in the queue\.$/)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText(/Waiting for .+\. Update .+ coverage in .+\./);
  const [cov] = await run<{ group_number: string; source: string }>(
    'select group_number, source from coverages where id = $1',
    [coverageId],
  );
  expect(cov).toEqual({ group_number: 'E2E-GRP-1', source: 'user' });
});

test('P-06 edits the patient details, and P-01 says the PM has not caught up', async () => {
  test.setTimeout(60_000);
  await page.goto(`/patients/${patientId}`);
  await expect(page.getByText(/^Corrected in Cleanpost and waiting for .+ to show it\./)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit patient details' });
  await expect(dialog.getByLabel('First name')).not.toHaveValue('');
  await expectAccessible(page, 'P-06');
  await dialog.getByLabel('Phone').fill('(503) 555-0199');
  await dialog.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText(/^Details saved\. A task to update .+ is in the queue\.$/)).toBeVisible();
  const tasks = await run<{ reason_code: string }>(
    `select reason_code from work_items where patient_id = $1 and type = 'manual_task' and status <> 'resolved' order by reason_code`,
    [patientId],
  );
  expect(tasks.map((t) => t.reason_code)).toEqual(['updateCoverage', 'updatePatient']);
});
