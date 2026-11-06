import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { expectAccessible, signedInPage } from './helpers';

/**
 * G-03 Global search and command palette. A few synthetic records are made here (the synced
 * patients have random names) and removed afterwards: two patients named Quillfeather in Lakeside
 * and Harbor Dermatology (outside Dana's clients), a rejected claim and the remittance that paid it.
 */
test.describe.configure({ mode: 'serial' });

const PCN = 'E2E-QF-004790';
const TRACE = 'E2EQF8810447';
let priya: Page;

const db = () =>
  new pg.Client({
    connectionString:
      process.env.DATABASE_ADMIN_URL ?? 'postgres://cleanpost:cleanpost@localhost:5432/cleanpost',
  });

async function run(sql: string) {
  const c = db();
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

const cleanUp = () =>
  run(`
    delete from remit_claims where patient_control_number = '${PCN}';
    delete from remittances where trace_number = '${TRACE}';
    update claims set current_version_id = null where patient_control_number = '${PCN}';
    delete from claim_versions where claim_id in (select id from claims where patient_control_number = '${PCN}');
    delete from claims where patient_control_number = '${PCN}';
    delete from encounters where patient_id in (select id from patients where last_name = 'Quillfeather');
    delete from patients where last_name = 'Quillfeather';`);

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  await cleanUp();
  await run(`
    with nw as (select id from tenants where name = 'Northwind Billing'),
    lake as (select id from clients where name = 'Lakeside Family Medicine'),
    ada as (
      insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
      select nw.id, lake.id, 'Ada', 'Quillfeather', '1984-03-07', 'F' from nw, lake returning id, tenant_id, client_id),
    basil as (
      insert into patients (tenant_id, client_id, first_name, last_name, dob, sex)
      select nw.id, c.id, 'Basil', 'Quillfeather', '2017-05-02', 'M'
      from nw, clients c where c.name = 'Harbor Dermatology' returning id),
    enc as (
      insert into encounters (tenant_id, client_id, patient_id, date_of_service, rendering_provider_id, location_id)
      select ada.tenant_id, ada.client_id, ada.id, '2026-10-22',
        (select id from providers where client_id = ada.client_id limit 1),
        (select id from locations where client_id = ada.client_id limit 1)
      from ada returning id, tenant_id, client_id, patient_id),
    cl as (
      insert into claims (tenant_id, client_id, patient_id, encounter_id, payer_id, patient_control_number,
        mode, total_charge_cents, status)
      select enc.tenant_id, enc.client_id, enc.patient_id, enc.id, (select id from payers where name = 'Aetna'),
        '${PCN}', 'A', 14500, 'rejected'
      from enc returning id, tenant_id, client_id),
    rem as (
      insert into remittances (tenant_id, client_id, payer_name, source, trace_number, payment_method,
        payment_amount_cents, payment_date)
      select tenant_id, client_id, 'Aetna', 'file', '${TRACE}', 'ACH', 210460, '2026-10-14' from cl
      returning id, tenant_id, client_id)
    insert into remit_claims (tenant_id, client_id, remittance_id, claim_id, patient_control_number,
      payer_claim_control_number, claim_status_code, charge_cents, paid_cents)
    select rem.tenant_id, rem.client_id, rem.id, cl.id, '${PCN}', 'E2EICN99887766', '1', 14500, 9000
    from rem, cl, basil;

    -- The claim page reads the claim's current version (IDs and codes only).
    insert into claim_versions (tenant_id, client_id, claim_id, version, payload, created_by)
    select c.tenant_id, c.client_id, c.id, 1, jsonb_build_object(
        'lines', jsonb_build_array(jsonb_build_object('ndc', null, 'code', '99213', 'units', 1,
          'modifiers', '[]'::jsonb, 'dxPointers', jsonb_build_array(1), 'lineNumber', 1, 'chargeCents', 14500,
          'chargeLineId', null, 'dateOfService', '2026-10-22')),
        'billing', jsonb_build_object('npi', '1700528874', 'taxonomy', null),
        'payerId', c.payer_id, 'payerName', 'Aetna',
        'facility', jsonb_build_object('npi', null, 'locationId', e.location_id, 'placeOfService', '11'),
        'diagnoses', jsonb_build_array(jsonb_build_object('icd10', 'J06.9', 'sequence', 1)),
        'patientId', c.patient_id,
        'rendering', jsonb_build_object('npi', '1559012731', 'taxonomy', null, 'providerId', e.rendering_provider_id),
        'coverageId', null, 'referringNpi', null, 'dateOfService', '2026-10-22', 'frequencyCode', '1',
        'priorAuthNumber', null, 'totalChargeCents', 14500),
      'e2e'
    from claims c join encounters e on e.id = c.encounter_id where c.patient_control_number = '${PCN}';
    update claims c set current_version_id = v.id from claim_versions v
    where v.claim_id = c.id and c.patient_control_number = '${PCN}';`);
  priya = await signedInPage(browser, info.project.use, 'priya@northwind.test');
});

test.afterAll(async () => {
  await priya.context().close();
  await cleanUp();
});

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search and commands' });
const box = (page: Page) => palette(page).getByRole('combobox', { name: 'Search or type a command' });
const group = (page: Page, name: string) => palette(page).getByRole('group', { name });

test('G-03 finds patients, claims and remittances by name, and opens one', async () => {
  test.setTimeout(90_000);
  await priya.goto('/work');
  await priya.getByRole('button', { name: /Search patients, claims, trace numbers/ }).click();
  await box(priya).fill('quillf');
  const patients = group(priya, 'Patients');
  // "Last, F." and an age only: no full name, no date of birth.
  await expect(patients.getByRole('option')).toHaveText([
    /Quillfeather, A\. · \d+ yLakeside Family Medicine/,
    /Quillfeather, B\. · \d+ yHarbor Dermatology/,
  ]);
  await expect(palette(priya)).not.toContainText('Ada');
  await expect(palette(priya)).not.toContainText('1984');
  const claim = group(priya, 'Claims').getByRole('option', { name: new RegExp(PCN) });
  await expect(claim).toContainText('Quillfeather, A. · Oct 22 · Aetna');
  await expect(claim).toContainText('Rejected');
  await expect(group(priya, 'Remittances').getByRole('option')).toContainText(
    `Aetna EFT ${TRACE} · includes Quillfeather, A.$2,104.60 · Oct 14`,
  );
  // The top hit is highlighted; Tab moves to the next group.
  await expect(patients.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await box(priya).press('Tab');
  await expect(claim).toHaveAttribute('aria-selected', 'true');
  await expectAccessible(priya, 'G-03');
  await priya.screenshot({ path: 'test-results/g03-search.png' });
  await box(priya).press('Enter');
  await expect(priya).toHaveURL(/\/claims\/[0-9a-f-]+$/);
  await expect(palette(priya)).toHaveCount(0);
  // The claim page records the view once it has rendered.
  await expect(priya.getByRole('heading', { level: 1 })).toContainText('Quillfeather', { timeout: 30_000 });

  // Opening it again with nothing typed lists that claim under Recent.
  await priya.locator('body').press('/');
  await expect(group(priya, 'Recent').getByRole('option').first()).toContainText(PCN);
  await expect(box(priya)).toHaveValue('');
});

test('G-03 shows the date of birth only on a DOB match, and finds trace and control numbers', async () => {
  test.setTimeout(60_000);
  await priya.goto('/work');
  await priya.keyboard.press('Control+k');
  await box(priya).fill('3/7/1984');
  await expect(group(priya, 'Patients').getByRole('option', { name: /Quillfeather, A\./ })).toContainText(
    'born Mar 7, 1984',
  );

  await box(priya).fill('e2eqf8810');
  await expect(group(priya, 'Remittances').getByRole('option')).toContainText(TRACE);
  await box(priya).fill('E2EICN998877');
  await expect(group(priya, 'Claims').getByRole('option')).toContainText(PCN);

  await box(priya).fill('zzqxv');
  await expect(palette(priya).getByText('Nothing matches “zzqxv”.')).toBeVisible();

  // Searches are recorded by hash and counts, never their text.
  const r = await run(`
    select a.metadata from audit_events a join users u on a.actor = 'user:' || u.id
    where u.email = 'priya@northwind.test' and a.action = 'search.performed' order by a.at desc limit 5`);
  expect(r.rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(r.rows).toLowerCase()).not.toMatch(/quill|e2eqf|zzqxv|1984/);
  await priya.keyboard.press('Escape');
});

test('G-03 commands start with ">" and open their page', async () => {
  test.setTimeout(60_000);
  await priya.goto('/work');
  await priya.keyboard.press('Control+k');
  await box(priya).fill('>upl');
  await expect(palette(priya).getByRole('option')).toHaveText(['Upload 835 fileRemittances']);
  await box(priya).press('Enter');
  await expect(priya).toHaveURL(/\/remittances\?upload=1$/);
  await expect(priya.getByRole('dialog', { name: 'Upload 835' })).toBeVisible();
});

test("G-03 keeps to a biller's clients and role", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const dana = await signedInPage(browser, info.project.use, 'dana@northwind.test');
  try {
    await dana.goto('/work');
    await dana.keyboard.press('Control+k');
    await box(dana).fill('quillf');
    await expect(group(dana, 'Patients').getByRole('option')).toHaveText([/Quillfeather, A\./]);
    await box(dana).fill('>invite');
    await expect(palette(dana).getByText('No commands match “invite”.')).toBeVisible();
  } finally {
    await dana.context().close();
  }
});
