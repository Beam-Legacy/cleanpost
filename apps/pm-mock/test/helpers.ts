import { createLogger } from '@cleanpost/log';
import { testDatabaseUrls } from '@cleanpost/db/testing';
import { generatePractice } from '@cleanpost/testing/synth';
import { createPmMockApp } from '../src/app';
import { createPmDb } from '../src/db';
import { apiKeyFor } from '../src/keys';
import { loadPractice, upsertAccount, upsertPractice } from '../src/load';
import { seedPmMock } from '../src/seed';

export const SECRET = 'pm-mock-test-secret-0123456789';
export const ADMIN_PASSWORD = 'admin-password-for-tests';
export const AS_OF = new Date('2026-10-30T15:00:00Z');

export const handle = createPmDb(testDatabaseUrls().adminUrl, 4);
export const log = createLogger({ name: 'pm-mock-test' });

/** The world's practices at a small scale, plus a generic-profile practice for full-capability tests. */
export async function seedTestWorld() {
  await seedPmMock(handle.db, { secret: SECRET, asOf: AS_OF, scale: 0.15 });
  await upsertAccount(handle.db, {
    id: 'generic-account',
    name: 'Generic PM account',
    profile: 'generic',
    apiKey: apiKeyFor(SECRET, 'generic-account'),
  });
  await upsertPractice(handle.db, {
    id: 'generic',
    accountId: 'generic-account',
    name: 'Generic Practice',
    specialty: 'family_medicine',
    providers: [{ npi: '1932204419', name: 'Provider One' }],
    locations: [{ id: 'GEN-L1', name: 'Main', placeOfService: '11' }],
  });
  await loadPractice(
    handle.db,
    'generic',
    generatePractice({
      seed: 'generic',
      idPrefix: 'GEN',
      specialty: 'family_medicine',
      city: 'Portland',
      state: 'OR',
      zips: ['97201'],
      areaCode: '503',
      providers: [{ npi: '1932204419' }],
      locations: [{ externalId: 'GEN-L1', placeOfService: '11' }],
      payers: [
        { name: 'Aetna', kind: 'commercial' },
        { name: 'Medicare (Noridian JF)', kind: 'medicare' },
      ],
      patients: 30,
      encounters: 60,
      asOf: AS_OF,
    }),
  );
}

export function testApp(opts: { rateScale?: number; now?: () => Date } = {}) {
  return createPmMockApp({
    db: handle.db,
    log,
    adminPassword: ADMIN_PASSWORD,
    rateScale: opts.rateScale ?? 1000,
    now: opts.now,
  });
}

export const key = (account: string) => apiKeyFor(SECRET, account);
export const bearer = (account: string) => ({ authorization: `Bearer ${key(account)}` });
export const adminAuth = {
  authorization: `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`,
};
