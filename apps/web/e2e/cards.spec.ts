import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { encryptField } from '@cleanpost/db';
import { records } from '@cleanpost/domain';
import { expectAccessible, signedInPage } from './helpers';

/**
 * P-04 card capture, P-05 review and W-14 (DEC-31), on the patient of the W-13 fixture
 * (e2e/fixtures/eligibility.ts). The cards are synthetic PNGs carrying their own answer, read by the
 * worker's stand-in reader. Everything the spec changes is undone afterwards.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let patientId: string;
/** The spec's own coverage (E2E Aetna, tertiary). */
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

/** A 1x1 PNG with the card's answer for the stand-in reader. */
function card(payerName: string, groupConfidence: number): Buffer {
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const answer = {
    fields: {
      payerName,
      memberId: 'E2E44177093',
      groupNumber: 'E2E-GRP-77',
      subscriberName: 'E2E Card Holder',
      planType: 'PPO',
      rxBin: '017010',
      payerPhone: '1-800-555-0199',
    },
    confidence: {
      payerName: 0.98,
      memberId: 0.97,
      groupNumber: groupConfidence,
      subscriberName: 0.97,
      planType: 0.95,
      rxBin: 0.93,
      payerPhone: 0.94,
    },
  };
  return Buffer.from(records.addPngText(png, records.SYNTHETIC_CARD_KEYWORD, records.asciiJson(answer)));
}

/** The spec's own coverage (the patient's tertiary one), cards and tasks removed. */
async function undo() {
  if (!patientId) return;
  // Made by this spec: tertiary, and never synced (no PM reference).
  const own = `(select c.id from coverages c where c.patient_id = $1 and c.priority = 3 and not exists
    (select 1 from external_refs r where r.entity_type = 'coverage' and r.entity_id = c.id))`;
  await run(
    `delete from corrections where entity_id in ${own}
        or entity_id in (select id from documents where patient_id = $1)
        or work_item_id in (select id from work_items where patient_id = $1 and type in ('manual_task', 'card_review'))`,
    [patientId],
  );
  await run(
    `delete from manual_tasks where work_item_id in (select id from work_items where patient_id = $1 and type = 'manual_task')`,
    [patientId],
  );
  await run(`delete from work_items where patient_id = $1 and type in ('manual_task', 'card_review')`, [
    patientId,
  ]);
  await run(
    `delete from document_blobs where storage_key in (select storage_key from documents where patient_id = $1)`,
    [patientId],
  );
  await run(`delete from documents where patient_id = $1`, [patientId]);
  await run(`delete from eligibility_checks where coverage_id in ${own}`, [patientId]);
  await run(`delete from coverages where id in ${own}`, [patientId]);
  await run(`update coverages set source = 'pm' where patient_id = $1`, [patientId]);
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const [row] = await run<{ patient_id: string; tenant_id: string; client_id: string }>(
    `select c.patient_id, c.tenant_id, c.client_id from work_items w
       join claims c on c.id = w.claim_id
       join eligibility_checks k on k.coverage_id = c.coverage_id
      where w.type = 'eligibility_issue' and k.summary->>'fixture' = 'e2e-eligibility'
      limit 1`,
  );
  expect(row, 'run e2e/fixtures/eligibility.ts (global setup does)').toBeDefined();
  patientId = row!.patient_id;
  await undo();
  // A third coverage of the spec's own, so confirming a card moves no claim (the claims use the
  // primary) and the W-13 spec still finds its fixture.
  const [cov] = await run<{ id: string }>(
    `insert into coverages (tenant_id, client_id, patient_id, payer_id, payer_name, priority, member_id_encrypted, member_id_last4)
     select $1, $2, $3, id, 'E2E Aetna', 3, $4, '0000' from payers where name = 'Aetna' returning id`,
    [row!.tenant_id, row!.client_id, patientId, encryptField('E2E00000000')],
  );
  coverageId = cov!.id;
  page = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await page.context().close();
  await undo();
});

async function uploadOnP01(file: Buffer) {
  await page.goto(`/patients/${patientId}`);
  await page.getByRole('button', { name: 'Add card' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add insurance card' });
  await dialog
    .getByLabel('Front of the card')
    .setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: file });
  await dialog.getByRole('button', { name: 'Upload and read' }).click();
  const review = page.getByRole('dialog', { name: 'Review insurance card' });
  // The worker reads it (the stand-in reader in local, preview and CI).
  await expect(review.getByRole('button', { name: 'Confirm card' })).toBeVisible({ timeout: 60_000 });
  return review;
}

test('P-04 refuses what is not a photo, and P-05 shows the reading next to the card', async () => {
  test.setTimeout(120_000);
  await page.goto(`/patients/${patientId}`);
  await page.getByRole('button', { name: 'Add card' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add insurance card' });
  await expectAccessible(page, 'P-04');
  await dialog.getByLabel('Front of the card').setInputFiles({
    name: 'front.png',
    mimeType: 'image/png',
    buffer: Buffer.from('%PDF-1.7 not an image'),
  });
  await dialog.getByRole('button', { name: 'Upload and read' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'The front photo is not a photo. Use a JPEG, PNG or WebP image.',
  );
  await page.keyboard.press('Escape');

  const review = await uploadOnP01(card('Cigna', 0.82));
  await expect(review.getByRole('img', { name: 'Front of the insurance card' })).toBeVisible();
  // The group number was read with 82%: marked, and focused first.
  const group = review.getByLabel('Group number');
  await expect(group).toHaveAttribute('aria-invalid', 'true');
  await expect(group).toBeFocused();
  await expect(review).toContainText('Check this: read with 82% confidence.');
  await expect(review.getByLabel('Member ID')).toHaveValue('E2E44177093');
  await review.getByLabel('Coverage to update').selectOption(coverageId);
  await expect(review).toContainText(
    'The card says Cigna, the coverage on file says E2E Aetna. Confirming moves this coverage to Cigna.',
  );
  await expectAccessible(page, 'P-05');
  // Closed without confirming, it waits in the queue as W-14.
  await page.keyboard.press('Escape');
  await expect(page.getByText('waiting for review')).toBeVisible();
});

test('W-14 confirms the card in the queue, and the coverage follows with a task for the PM', async () => {
  test.setTimeout(90_000);
  const [item] = await run<{ id: string }>(
    `select id from work_items where patient_id = $1 and type = 'card_review' and status <> 'resolved'`,
    [patientId],
  );
  expect(item).toBeDefined();
  await page.goto(`/work?item=${item!.id}`);
  const panel = page.getByRole('complementary', { name: 'Card review' });
  await expect(panel.getByRole('button', { name: 'Confirm card' })).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, 'W-14');
  await panel.getByLabel('Coverage to update').selectOption(coverageId);
  await panel.getByLabel('Check eligibility after saving').uncheck();
  await panel.getByRole('button', { name: 'Confirm card' }).click();
  await expect(
    page.getByText(/^Card confirmed and coverage updated\. A task to update .+ is in the queue\.$/),
  ).toBeVisible();
  const [cov] = await run<{
    payer_name: string;
    group_number: string;
    source: string;
    member_id_last4: string;
  }>('select payer_name, group_number, source, member_id_last4 from coverages where id = $1', [coverageId]);
  expect(cov).toEqual({
    payer_name: 'Cigna',
    group_number: 'E2E-GRP-77',
    source: 'card',
    member_id_last4: '7093',
  });
  const [w14] = await run<{ status: string; resolution: string }>(
    'select status, resolution from work_items where id = $1',
    [item!.id],
  );
  expect(w14).toEqual({ status: 'resolved', resolution: 'Fields confirmed' });
});
