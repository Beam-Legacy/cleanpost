/**
 * Loads generated synthetic practices into the mock PM, and adds new visits on demand so a demo can
 * show fresh charges arriving through sync. Loading is idempotent: a practice that already has
 * encounters is left as it is.
 */
import { generatePractice, type SynthPractice } from '@cleanpost/testing/synth';
import type { SpecialtyKey } from '@cleanpost/testing/synth';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { PmDb } from './db';
import { hashApiKey } from './keys';
import { TEBRA_WORKFLOW } from './profiles';
import {
  accounts,
  adjustmentCodes,
  answerKey,
  charges,
  claims,
  encounters,
  locations,
  patients,
  policies,
  practices,
  providers,
  type ProfileKey,
} from './schema';

export interface AccountSetup {
  id: string;
  name: string;
  profile: ProfileKey;
  apiKey: string;
}

export interface PracticeSetup {
  id: string;
  accountId: string;
  name: string;
  specialty: SpecialtyKey;
  providers: { npi: string; name: string }[];
  locations: { id: string; name: string; placeOfService: string }[];
}

/** Tebra-style adjustment codes the mock PM posts with (the PM's own codes, not CARCs). */
export const ADJUSTMENT_CODES = [
  { code: 'CONTR', label: 'Contractual adjustment' },
  { code: 'PTRESP', label: 'Patient responsibility transfer' },
  { code: 'DEDUCT', label: 'Deductible' },
  { code: 'COINS', label: 'Coinsurance' },
  { code: 'COPAY', label: 'Copay' },
  { code: 'WO', label: 'Small balance write-off' },
];

const chunk = <T>(items: T[], size = 500): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export async function upsertAccount(db: PmDb, a: AccountSetup): Promise<void> {
  await db
    .insert(accounts)
    .values({ id: a.id, name: a.name, profile: a.profile, apiKeyHash: hashApiKey(a.apiKey) })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { name: a.name, profile: a.profile, apiKeyHash: hashApiKey(a.apiKey) },
    });
}

export async function upsertPractice(db: PmDb, p: PracticeSetup): Promise<void> {
  await db
    .insert(practices)
    .values({ id: p.id, accountId: p.accountId, name: p.name, specialty: p.specialty })
    .onConflictDoUpdate({ target: practices.id, set: { name: p.name, specialty: p.specialty } });
  for (const pr of p.providers) {
    await db.insert(providers).values({ practiceId: p.id, npi: pr.npi, name: pr.name }).onConflictDoNothing();
  }
  for (const l of p.locations) {
    await db
      .insert(locations)
      .values({ id: l.id, practiceId: p.id, name: l.name, placeOfService: l.placeOfService })
      .onConflictDoNothing();
  }
  for (const a of ADJUSTMENT_CODES) {
    await db
      .insert(adjustmentCodes)
      .values({ practiceId: p.id, ...a })
      .onConflictDoNothing();
  }
}

async function profileOf(db: PmDb, practiceId: string): Promise<ProfileKey> {
  const [row] = await db
    .select({ profile: accounts.profile })
    .from(practices)
    .innerJoin(accounts, eq(accounts.id, practices.accountId))
    .where(eq(practices.id, practiceId));
  if (!row) throw new Error('practice not found');
  return row.profile;
}

async function insertEncounters(
  db: PmDb,
  practiceId: string,
  profile: ProfileKey,
  list: SynthPractice['encounters'],
): Promise<void> {
  for (const part of chunk(list, 300)) {
    await db.insert(encounters).values(
      part.map((e) => ({
        id: e.externalId,
        practiceId,
        patientId: e.patientExternalId,
        dateOfService: e.dateOfService,
        renderingNpi: e.renderingProviderNpi,
        locationId: e.locationExternalId,
        placeOfService: e.placeOfService,
        priorAuthNumber: e.priorAuthNumber ?? null,
        diagnoses: e.diagnoses,
        status: e.status,
        workflowStatus: profile === 'tebra' ? TEBRA_WORKFLOW[e.status]! : null,
        updatedAt: new Date(e.updatedAt),
      })),
    );
    const lines = part.flatMap((e) =>
      e.lines.map((l, i) => ({
        id: l.externalId,
        encounterId: e.externalId,
        lineNumber: i + 1,
        code: l.code,
        modifiers: l.modifiers,
        units: l.units,
        chargeCents: l.chargeCents,
        pointers: l.diagnosisPointers,
      })),
    );
    if (lines.length) await db.insert(charges).values(lines);
    // The PM already sent its billed encounters through its clearinghouse.
    const billed = part.filter((e) => e.status === 'billed');
    if (billed.length) {
      await db.insert(claims).values(
        billed.map((e) => ({
          encounterId: e.externalId,
          practiceId,
          patientControlNumber: e.externalId,
          status: 'accepted',
          updatedAt: new Date(e.updatedAt),
        })),
      );
    }
  }
}

/** Loads one generated practice. Returns false when the practice already has data. */
export async function loadPractice(db: PmDb, practiceId: string, data: SynthPractice): Promise<boolean> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(encounters)
    .where(eq(encounters.practiceId, practiceId));
  if (n > 0) return false;
  const profile = await profileOf(db, practiceId);
  await loadPatients(db, practiceId, data);
  await insertEncounters(db, practiceId, profile, data.encounters);
  const facts = Object.entries(data.answerKey.encounters).map(([id, defects]) => ({
    practiceId,
    recordType: 'encounter',
    recordId: id,
    facts: {
      defects,
      ...(data.answerKey.duplicateOf[id] ? { duplicateOf: data.answerKey.duplicateOf[id] } : {}),
    },
  }));
  for (const part of chunk(facts)) await db.insert(answerKey).values(part).onConflictDoNothing();
  return true;
}

/**
 * A practice's patients and their coverage, with the coverage facts payers know (inactive, really
 * another payer's member), and no visits. Demo history (DEC-19) adds the visits day by day.
 */
export async function loadPatients(db: PmDb, practiceId: string, data: SynthPractice): Promise<void> {
  for (const part of chunk(data.patients)) {
    await db
      .insert(patients)
      .values(
        part.map((p) => ({
          id: p.externalId,
          practiceId,
          firstName: p.firstName,
          lastName: p.lastName,
          dob: p.dob,
          sex: p.sex,
          address: p.address,
          phone: p.phone,
          updatedAt: new Date(p.updatedAt),
        })),
      )
      .onConflictDoNothing();
    const pols = part.flatMap((p) =>
      p.coverages.map((c) => ({
        id: c.externalId,
        practiceId,
        patientId: p.externalId,
        payerName: c.payerName,
        priority: c.priority,
        memberId: c.memberId,
        groupNumber: c.groupNumber ?? null,
        relationship: c.relationship,
        subscriber: c.subscriber ?? null,
        effectiveDate: c.effectiveDate ?? null,
        terminationDate: c.terminationDate ?? null,
      })),
    );
    if (pols.length) await db.insert(policies).values(pols).onConflictDoNothing();
  }
  const facts = Object.entries(data.answerKey.coverages).map(([id, f]) => ({
    practiceId,
    recordType: 'coverage',
    recordId: id,
    facts: f,
  }));
  for (const part of chunk(facts)) await db.insert(answerKey).values(part).onConflictDoNothing();
}

export interface VisitInput {
  practiceId: string;
  count: number;
  now: Date;
  /** The visits' date (default today); entered now, so the next sync brings them. */
  dateOfService?: string;
  /** Share left open (Draft in Tebra) for the practice to finish later. Default a third. */
  openShare?: number;
}

/**
 * Adds today's visits for existing patients, as a practice would during the day. New encounters
 * arrive in Draft or Review (Tebra) or open/ready, so the next sync shows them as new charges.
 */
export async function addVisits(db: PmDb, input: VisitInput): Promise<string[]> {
  const [practice] = await db.select().from(practices).where(eq(practices.id, input.practiceId));
  if (!practice) throw new Error('practice not found');
  const profile = await profileOf(db, practice.id);
  const [provs, locs, pats, last] = await Promise.all([
    db.select().from(providers).where(eq(providers.practiceId, practice.id)),
    db.select().from(locations).where(eq(locations.practiceId, practice.id)),
    db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.practiceId, practice.id))
      .orderBy(sql`random()`)
      .limit(input.count),
    db.execute<{ id: string }>(
      sql`select id from pm_mock.encounters where practice_id = ${practice.id} order by length(id) desc, id desc limit 1`,
    ),
  ]);
  if (pats.length === 0) return [];
  const lastId = last.rows[0]?.id ?? `${practice.id.toUpperCase()}-E10000`;
  const match = /^(.*)-E(\d+)$/.exec(lastId);
  const prefix = match?.[1] ?? practice.id.toUpperCase();
  let next = Number(match?.[2] ?? 10_000) + 1;
  const generated = generatePractice({
    seed: `${practice.id}:${input.now.toISOString()}`,
    idPrefix: 'NEW',
    specialty: practice.specialty as SpecialtyKey,
    city: 'Portland',
    state: 'OR',
    zips: ['97201'],
    areaCode: '503',
    providers: provs.map((p) => ({ npi: p.npi })),
    locations: locs.map((l) => ({ externalId: l.id, placeOfService: l.placeOfService })),
    // Only the encounters are used; they are moved onto existing patients below.
    payers: [{ name: 'Placeholder', kind: 'commercial' }],
    patients: 1,
    encounters: input.count,
    asOf: input.now,
    windowDays: 0,
    defectRates: { duplicate: 0 },
    // A day's handful of visits: each draws its own defects, so the scrub has something to catch.
    defectSampling: 'each',
  });
  const openEvery =
    input.openShare === undefined ? 3 : input.openShare > 0 ? Math.round(1 / input.openShare) : 0;
  const fresh = generated.encounters.map((e, i) => {
    const id = `${prefix}-E${next++}`;
    return {
      ...e,
      externalId: id,
      patientExternalId: pats[i % pats.length]!.id,
      dateOfService: input.dateOfService ?? input.now.toISOString().slice(0, 10),
      status: (openEvery && i % openEvery === 0 ? 'open' : 'ready') as 'open' | 'ready',
      lines: e.lines.map((l, n) => ({ ...l, externalId: `${id}-${n + 1}` })),
      updatedAt: input.now.toISOString(),
    };
  });
  await insertEncounters(db, practice.id, profile, fresh);
  return fresh.map((e) => e.externalId);
}

export async function practiceCounts(db: PmDb, practiceIds: string[]) {
  if (practiceIds.length === 0) return [];
  return db
    .select({ practiceId: encounters.practiceId, n: count() })
    .from(encounters)
    .where(and(inArray(encounters.practiceId, practiceIds)))
    .groupBy(encounters.practiceId);
}
