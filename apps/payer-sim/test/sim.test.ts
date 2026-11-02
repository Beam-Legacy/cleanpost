import { afterAll, describe, expect, it } from 'vitest';
import { npiFromBase } from '@cleanpost/domain';
import { testDatabaseName, testDatabaseUrls } from '@cleanpost/db/testing';
import { createLogger } from '@cleanpost/log';
import { acknowledge, ackDelayMinutes, createPayerSimApp, createSimDb, type SubmittedClaim } from '../src';

const claim = (over: Partial<SubmittedClaim> = {}): SubmittedClaim => ({
  patientControlNumber: 'LFM-E10001',
  payerName: 'Aetna',
  dateOfService: '2026-10-27',
  renderingNpi: npiFromBase('193220441'),
  billingNpi: npiFromBase('148772659'),
  member: { status: 'active' },
  diagnoses: [{ sequence: 1, icd10: 'E11.9' }],
  lines: [{ lineNumber: 1, code: '99213', modifiers: [], units: 1, chargeCents: 14_500, pointers: [1] }],
  totalChargeCents: 14_500,
  ...over,
});

describe('277CA front-end edits', () => {
  it('accepts a clean claim (A2:20)', () => {
    expect(acknowledge(claim())).toEqual({ status: 'accepted', codes: ['A2:20'], reasons: [] });
  });

  it('rejects a member the payer cannot find, an invalid NPI, a bad pointer and a wrong total', () => {
    expect(acknowledge(claim({ member: { status: 'not_found' } }))).toMatchObject({
      status: 'rejected',
      codes: ['A7:33'],
      reasons: ['Subscriber not found'],
    });
    expect(acknowledge(claim({ renderingNpi: '1234567890' })).codes).toEqual(['A7:562']);
    const bad = claim();
    bad.lines[0]!.pointers = [2];
    expect(acknowledge(bad).codes).toEqual(['A7:255']);
    expect(acknowledge(claim({ totalChargeCents: 1 })).codes).toEqual(['A7:178']);
  });

  it('accepts inactive coverage at the front end (it is denied at adjudication)', () => {
    expect(acknowledge(claim({ member: { status: 'inactive' } })).status).toBe('accepted');
  });

  it('acknowledges 1 to 30 minutes after receipt, the same delay every time', () => {
    const ds = ['a', 'b', 'c', 'pm-mock:lakeside:LFM-E1'].map(ackDelayMinutes);
    expect(ds.every((d) => d >= 1 && d <= 30)).toBe(true);
    expect(ackDelayMinutes('x')).toBe(ackDelayMinutes('x'));
  });
});

interface AcksBody {
  acks: { patientControlNumber: string; status: string; at: string }[];
}
const acks = async (res: Response | Promise<Response>) => (await (await res).json()) as AcksBody;

describe('payer-sim API', () => {
  const handle = createSimDb(testDatabaseUrls(testDatabaseName('payer_sim')).adminUrl, 2);
  const token = 'payer-sim-test-token-0123456789';
  const app = createPayerSimApp({ db: handle.db, log: createLogger({ name: 'payer-sim-test' }), token });
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  afterAll(() => handle.close());

  it('needs the submitter token', async () => {
    expect((await app.request('/claims', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('holds 277CAs until the simulated clock reaches them, then returns them once per cursor', async () => {
    const source = 'pm-mock:test';
    const res = await app.request('/claims', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        source,
        claims: [claim(), claim({ patientControlNumber: 'LFM-E10002', member: { status: 'not_found' } })],
      }),
    });
    expect(await res.json()).toEqual({ received: 2 });
    const before = await acks(app.request(`/acks?source=${source}`, { headers: auth }));
    expect(before.acks).toEqual([]);

    const advanced = await app.request('/clock/advance?minutes=31', { method: 'POST', headers: auth });
    expect(advanced.status).toBe(200);
    const after = await acks(app.request(`/acks?source=${source}`, { headers: auth }));
    expect(
      after.acks
        .map((a: { patientControlNumber: string; status: string }) => [a.patientControlNumber, a.status])
        .sort(),
    ).toEqual([
      ['LFM-E10001', 'accepted'],
      ['LFM-E10002', 'rejected'],
    ]);
    const last = after.acks.at(-1)!.at;
    const again = await acks(
      app.request(`/acks?source=${source}&since=${encodeURIComponent(last)}`, { headers: auth }),
    );
    expect(again.acks).toEqual([]);
  });

  it('refuses claims that do not match the shape', async () => {
    const res = await app.request('/claims', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ source: 'x', claims: [{ patientControlNumber: 'only' }] }),
    });
    expect(res.status).toBe(422);
  });
});
