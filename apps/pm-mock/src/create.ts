/**
 * Onboarding demo (O-04, local and preview): a new practice in the mock PM, so a billing company
 * can onboard it end to end. An account (with the API key the caller derived from the shared
 * secret; only its hash is kept), the practice with its providers and locations, and generated
 * synthetic patients and visits. Synthetic data only.
 */
import { randomBytes } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generatePractice } from '@cleanpost/testing/synth';
import type { PmDb } from './db';
import { loadPractice, upsertAccount, upsertPractice } from './load';
import { accounts, encounters, practices } from './schema';

export const createPracticeBody = z.object({
  name: z.string().trim().min(2).max(120),
  profile: z.enum(['generic', 'tebra', 'managed_api']),
  specialty: z.enum(['family_medicine', 'pediatrics', 'orthopedics']).default('family_medicine'),
  city: z.string().trim().min(2).max(60).default('Portland'),
  providers: z
    .array(z.object({ npi: z.string().regex(/^\d{10}$/), name: z.string().trim().min(2).max(120) }))
    .min(1)
    .max(20),
  locations: z
    .array(z.object({ name: z.string().trim().min(2).max(120), placeOfService: z.string().regex(/^\d{2}$/) }))
    .min(1)
    .max(10),
  payers: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        kind: z.enum(['medicare', 'medicaid', 'commercial']),
      }),
    )
    .min(1)
    .max(20),
  patients: z.number().int().min(5).max(400).default(60),
  encounters: z.number().int().min(5).max(800).default(120),
  /** Derived by the caller from PM_MOCK_SECRET for `accountId` (apiKeyFor); stored hashed. */
  accountId: z.string().regex(/^[a-z0-9-]{3,60}$/),
  apiKey: z.string().min(24).max(200),
});
export type CreatePracticeInput = z.input<typeof createPracticeBody>;

/** A practice ID from the name: "Harbor Dermatology" -> "harbor-dermatology-3f9a". */
export const practiceIdFor = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'practice'
  }-${randomBytes(2).toString('hex')}`;

export async function createPractice(db: PmDb, input: z.output<typeof createPracticeBody>, asOf: Date) {
  const practiceId = practiceIdFor(input.name);
  const prefix =
    input.name
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3)
      .padEnd(3, 'X') + randomBytes(1).toString('hex').toUpperCase();
  const locs = input.locations.map((l, i) => ({ id: `${practiceId}-loc-${i + 1}`, ...l }));
  await upsertAccount(db, {
    id: input.accountId,
    name: `${input.name} (${input.profile === 'tebra' ? 'Tebra' : input.profile === 'managed_api' ? 'AdvancedMD' : 'PM'} account)`,
    profile: input.profile,
    apiKey: input.apiKey,
  });
  await upsertPractice(db, {
    id: practiceId,
    accountId: input.accountId,
    name: input.name,
    specialty: input.specialty,
    providers: input.providers,
    locations: locs,
  });
  const data = generatePractice({
    seed: `pm-mock:${practiceId}`,
    idPrefix: prefix,
    specialty: input.specialty,
    city: input.city,
    state: 'OR',
    zips: ['97201', '97205', '97214'],
    areaCode: '503',
    providers: input.providers.map((p) => ({ npi: p.npi })),
    locations: locs.map((l) => ({ externalId: l.id, placeOfService: l.placeOfService })),
    payers: input.payers,
    patients: input.patients,
    encounters: input.encounters,
    asOf,
  });
  await loadPractice(db, practiceId, data);
  return {
    accountId: input.accountId,
    practiceId,
    locations: locs.map((l) => ({ id: l.id, name: l.name })),
    patients: data.patients.length,
    encounters: data.encounters.length,
  };
}

/** Practices in the mock PM, for O-04's "connect to an existing practice". */
export async function listPractices(db: PmDb) {
  const rows = await db
    .select({
      id: practices.id,
      name: practices.name,
      accountId: practices.accountId,
      profile: accounts.profile,
    })
    .from(practices)
    .innerJoin(accounts, eq(accounts.id, practices.accountId))
    .orderBy(practices.name);
  const counts = await db
    .select({ practiceId: encounters.practiceId, n: count() })
    .from(encounters)
    .groupBy(encounters.practiceId);
  return rows.map((r) => ({ ...r, encounters: counts.find((c) => c.practiceId === r.id)?.n ?? 0 }));
}
