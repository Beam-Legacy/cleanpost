import { afterAll, describe, expect, it } from 'vitest';
import { testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { createPayerSimApp, createSimDb } from '../src';

const handle = createSimDb(testDatabaseUrls(testDatabaseName('payer_sim')).adminUrl, 2);
const token = 'payer-sim-test-token-0123456789';
const app = createPayerSimApp({ db: handle.db, log: createLogger({ name: 'payer-sim-test' }), token });
afterAll(() => handle.close());

const post = (path: string, body: unknown, auth = `Bearer ${token}`) =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ELIG = '/2024-04-01/change/medicalnetwork/eligibility/v3';
const req = (memberId: string | undefined, dateOfService = '20261027') => ({
  tradingPartnerServiceId: 'SIMAETNA',
  provider: { organizationName: 'Lakeside Family Medicine', npi: '1487726595' },
  subscriber: { ...(memberId ? { memberId } : {}), dateOfBirth: '19800214' },
  encounter: { dateOfService, serviceTypeCodes: ['30'] },
});
type Body = {
  errors?: { code: string }[];
  planStatus?: { statusCode: string }[];
  benefitsInformation?: { code: string; benefitAmount?: string; benefitPercent?: string }[];
};

describe('eligibility (Stedi-shaped 270/271)', () => {
  it('loads the member file', async () => {
    const res = await post('/members', {
      members: [
        {
          payerId: 'SIMAETNA',
          memberId: 'W100200300',
          dateOfBirth: '19800214',
          status: 'active',
          planBegin: '20260101',
          planEnd: '20261231',
          copayCents: 2500,
          deductibleRemainingCents: 45_000,
          coinsurancePercent: 20,
        },
        { payerId: 'SIMAETNA', memberId: 'W100200399', dateOfBirth: '19800214', status: 'inactive' },
      ],
    });
    expect(await res.json()).toEqual({ loaded: 2 });
  });

  it('answers active coverage with copay, deductible and coinsurance', async () => {
    const body = (await (await post(ELIG, req('W100200300'), token)).json()) as Body;
    expect(body.planStatus?.[0]?.statusCode).toBe('1');
    expect(body.benefitsInformation?.map((b) => b.code)).toEqual(['1', 'B', 'C', 'A']);
    expect(body.benefitsInformation?.find((b) => b.code === 'B')?.benefitAmount).toBe('25.00');
    expect(body.benefitsInformation?.find((b) => b.code === 'A')?.benefitPercent).toBe('0.20');
  });

  it('answers inactive for a lapsed member or a date outside the plan', async () => {
    const lapsed = (await (await post(ELIG, req('W100200399'))).json()) as Body;
    expect(lapsed.benefitsInformation?.[0]?.code).toBe('6');
    const outside = (await (await post(ELIG, req('W100200300', '20270105'))).json()) as Body;
    expect(outside.benefitsInformation?.[0]?.code).toBe('6');
  });

  it('returns AAA errors for an unknown or missing member', async () => {
    expect(((await (await post(ELIG, req('NOPE'))).json()) as Body).errors?.[0]?.code).toBe('75');
    expect(((await (await post(ELIG, req(undefined))).json()) as Body).errors?.[0]?.code).toBe('72');
  });

  it('accepts the key the way Stedi does (raw), and refuses a wrong one', async () => {
    expect((await post(ELIG, req('W100200300'), 'wrong')).status).toBe(401);
  });
});
