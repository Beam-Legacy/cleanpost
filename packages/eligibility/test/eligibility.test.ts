import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  coverages,
  createDatabase,
  eligibilityChecks,
  encryptField,
  last4,
  patients,
  withTenant,
} from '@cleanpost/db';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { createPayerSimApp, createSimDb } from '@cleanpost/payer-sim';
import { seed } from '@cleanpost/seed';
import { CLIENTS, NORTHWIND, PAYERS } from '@cleanpost/seed/world';
import { scanForPhi } from '@cleanpost/testing';
import { checkCoverage, coveragesNeedingCheck, createStediEligibilityClient, summarize271 } from '../src';

const urls = testDatabaseUrls();
const admin = createDatabase(urls.adminUrl, { max: 2 });
const app = createDatabase(urls.url, { max: 4 });
const simDb = createSimDb(urls.adminUrl, 2);
const log = createLogger({ name: 'eligibility-test' });
const sim = createPayerSimApp({ db: simDb.db, log, token: 'payer-sim-test-token-0123456789' });
const client = createStediEligibilityClient({
  apiKey: 'payer-sim-test-token-0123456789',
  baseUrl: 'http://payer-sim.test',
  kind: 'payer-sim',
  fetch: ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(sim.request(String(input).replace('http://payer-sim.test', ''), init))) as typeof fetch,
});
const deps = { db: app.db, client, log };
const lakeside = CLIENTS.find((c) => c.name.startsWith('Lakeside'))!;
const aetna = PAYERS.find((p) => p.name === 'Aetna')!;

async function coverage(memberId: string) {
  const [p] = await admin.db
    .insert(patients)
    .values({
      tenantId: NORTHWIND,
      clientId: lakeside.id,
      firstName: 'Avery',
      lastName: 'Test',
      dob: '1980-02-14',
    })
    .returning();
  const [c] = await admin.db
    .insert(coverages)
    .values({
      tenantId: NORTHWIND,
      clientId: lakeside.id,
      patientId: p!.id,
      payerId: aetna.id,
      payerName: 'Aetna',
      priority: 1,
      memberIdEncrypted: encryptField(memberId),
      memberIdLast4: last4(memberId),
    })
    .returning();
  return c!.id;
}

beforeAll(async () => {
  await seed(admin.db, 'eligibility-test-password-1');
  await sim.request('/members', {
    method: 'POST',
    headers: { authorization: 'Bearer payer-sim-test-token-0123456789', 'content-type': 'application/json' },
    body: JSON.stringify({
      members: [
        {
          payerId: 'SIMAETNA',
          memberId: 'W555000111',
          dateOfBirth: '19800214',
          status: 'active',
          copayCents: 2500,
          deductibleRemainingCents: 50_000,
          coinsurancePercent: 20,
        },
        { payerId: 'SIMAETNA', memberId: 'W555000222', dateOfBirth: '19800214', status: 'inactive' },
      ],
    }),
  });
}, 120_000);

afterAll(async () => {
  await Promise.all([admin.close(), app.close(), simDb.close()]);
});

describe('summarize271', () => {
  it('reads Stedi-shaped 271s: active with cost sharing, inactive, and AAA errors', () => {
    expect(
      summarize271({
        planDateInformation: { plan: '20260101-20261231' },
        benefitsInformation: [
          { code: '1', name: 'Active Coverage' },
          { code: 'B', benefitAmount: '30', inPlanNetworkIndicatorCode: 'Y' },
          { code: 'C', benefitAmount: '1250.50', inPlanNetworkIndicatorCode: 'Y' },
          { code: 'A', benefitPercent: '0.2', inPlanNetworkIndicatorCode: 'Y' },
        ],
      }),
    ).toEqual({
      status: 'active',
      planBegin: '2026-01-01',
      planEnd: '2026-12-31',
      copayCents: 3000,
      deductibleRemainingCents: 125_050,
      coinsurancePercent: 20,
      errorCodes: [],
    });
    expect(summarize271({ benefitsInformation: [{ code: '6' }] }).status).toBe('inactive');
    expect(summarize271({ errors: [{ code: '75' }] })).toMatchObject({ status: 'error', errorCodes: ['75'] });
    expect(summarize271('not json').status).toBe('unknown');
  });
});

describe('checkCoverage against payer-sim', () => {
  it('stores an active result with cost sharing and no identifiers, and audits the member ID read', async () => {
    const id = await coverage('W555000111');
    const res = await checkCoverage(deps, { tenantId: NORTHWIND, coverageId: id });
    expect(res).toMatchObject({ status: 'checked', result: 'active' });
    const [row] = await admin.db.select().from(eligibilityChecks).where(eq(eligibilityChecks.coverageId, id));
    expect(row).toMatchObject({ status: 'active' });
    expect(row!.summary).toMatchObject({ copayCents: 2500, coinsurancePercent: 20, source: 'payer-sim' });
    expect(JSON.stringify(row!.summary)).not.toContain('W555000111');
    expect(scanForPhi(JSON.stringify(row!.summary))).toEqual([]);
    const audit = await admin.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, 'coverage.member_id_read')));
    expect(audit).toHaveLength(1);
  });

  it('stores inactive coverage, and a payer error for a member it cannot find', async () => {
    const inactive = await coverage('W555000222');
    expect(await checkCoverage(deps, { tenantId: NORTHWIND, coverageId: inactive })).toMatchObject({
      result: 'inactive',
    });
    const missing = await coverage('W555000999');
    expect(await checkCoverage(deps, { tenantId: NORTHWIND, coverageId: missing })).toMatchObject({
      result: 'error',
    });
    const [row] = await admin.db
      .select()
      .from(eligibilityChecks)
      .where(eq(eligibilityChecks.coverageId, missing));
    expect(row!.summary).toMatchObject({ errorCodes: ['75'] });
  });

  it('checks a coverage again only when its last check is older than 7 days', async () => {
    const id = await coverage('W555000111');
    const now = new Date();
    const needs = (at: Date) =>
      withTenant(app.db, { tenantId: NORTHWIND }, (tx) => coveragesNeedingCheck(tx, [id], at));
    expect(await needs(now)).toEqual([id]);
    await checkCoverage(deps, { tenantId: NORTHWIND, coverageId: id });
    expect(await needs(now)).toEqual([]);
    expect(await needs(new Date(now.getTime() + 8 * 86_400_000))).toEqual([id]);
  });

  it('reports a retryable failure without storing a result when the payer is down', async () => {
    const down = createStediEligibilityClient({
      apiKey: 'k',
      baseUrl: 'http://payer-sim.test',
      fetch: (() => Promise.resolve(new Response('unavailable', { status: 503 }))) as typeof fetch,
    });
    const id = await coverage('W555000111');
    expect(
      await checkCoverage({ db: app.db, client: down, log }, { tenantId: NORTHWIND, coverageId: id }),
    ).toEqual({
      status: 'failed',
      retryable: true,
      code: 'HTTP_503',
    });
    expect(
      await admin.db.select().from(eligibilityChecks).where(eq(eligibilityChecks.coverageId, id)),
    ).toHaveLength(0);
  });
});
