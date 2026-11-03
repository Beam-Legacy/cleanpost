/**
 * Loads the synthetic world's mock-PM practices (packages/seed world.ts): accounts with keys derived
 * from PM_MOCK_SECRET, practices, providers, locations and generated patients and encounters.
 * Idempotent: practices that already have data are skipped.
 */
import { CLIENTS, PAYERS, npi, pmLocationId } from '@cleanpost/seed/world';
import { sql } from 'drizzle-orm';
import { generatePractice } from '@cleanpost/testing/synth';
import type { PmDb } from './db';
import { apiKeyFor } from './keys';
import { loadPatients, loadPractice, upsertAccount, upsertPractice } from './load';
import { accounts, practices, type ProfileKey } from './schema';

export interface SeedResult {
  practiceId: string;
  loaded: boolean;
  patients: number;
  encounters: number;
}

export async function seedPmMock(
  db: PmDb,
  opts: { secret: string; asOf: Date; scale?: number },
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  const scale = opts.scale ?? 1;
  for (const c of CLIENTS) {
    const m = c.pmMock;
    if (!m) continue;
    await upsertAccount(db, {
      id: m.accountId,
      name: m.accountName,
      profile: c.profile as ProfileKey,
      apiKey: apiKeyFor(opts.secret, m.accountId),
    });
    const locations = c.locations.map((l, i) => ({
      id: pmLocationId(c, i + 1),
      name: l.name,
      placeOfService: l.pos,
    }));
    const providers = c.providers.map((p) => ({ npi: npi(p.npiBase), name: p.name }));
    await upsertPractice(db, {
      id: m.practiceId,
      accountId: m.accountId,
      name: c.name,
      specialty: m.specialty,
      providers,
      locations,
    });
    const data = practiceData(c, opts.asOf, scale);
    const loaded = await loadPractice(db, m.practiceId, data);
    results.push({
      practiceId: m.practiceId,
      loaded,
      patients: data.patients.length,
      encounters: data.encounters.length,
    });
  }
  return results;
}

type WorldClient = (typeof CLIENTS)[number];

function practiceData(c: WorldClient, asOf: Date, scale: number) {
  const m = c.pmMock!;
  const locations = c.locations.map((l, i) => ({ id: pmLocationId(c, i + 1), placeOfService: l.pos }));
  const providers = c.providers.map((p) => ({ npi: npi(p.npiBase) }));
  return generatePractice({
    seed: `pm-mock:${m.practiceId}`,
    idPrefix: m.idPrefix,
    specialty: m.specialty,
    city: c.city,
    state: 'OR',
    zips: m.zips,
    areaCode: m.areaCode,
    providers,
    locations: locations.map((l) => ({ externalId: l.id, placeOfService: l.placeOfService })),
    payers: c.payerIds.map((id) => {
      const p = PAYERS.find((x) => x.id === id)!;
      return { name: p.name, kind: p.kind };
    }),
    patients: Math.max(1, Math.round(m.patients * scale)),
    encounters: Math.max(1, Math.round(m.encounters * scale)),
    asOf,
  });
}

/**
 * Demo history (DEC-19): forgets every visit, claim, payment and posting, and loads each practice's
 * patients and coverage again as of `asOf` (90 days back), with no visits; the replay adds those day
 * by day. Accounts, keys, practices, providers and locations stay. Local and preview only.
 */
export async function resetPmMockForHistory(
  db: PmDb,
  opts: { asOf: Date; scale?: number },
): Promise<{ practiceId: string; patients: number }[]> {
  await db.execute(sql`truncate pm_mock.postings, pm_mock.payments, pm_mock.remittances, pm_mock.claims,
    pm_mock.charges, pm_mock.encounters, pm_mock.policies, pm_mock.patients, pm_mock.answer_key,
    pm_mock.write_log, pm_mock.clearinghouse_state`);
  await db.update(accounts).set({ faults: [] });
  const present = new Set((await db.select({ id: practices.id }).from(practices)).map((p) => p.id));
  const out: { practiceId: string; patients: number }[] = [];
  for (const c of CLIENTS) {
    if (!c.pmMock || !present.has(c.pmMock.practiceId)) continue;
    const data = practiceData(c, opts.asOf, opts.scale ?? 1);
    await loadPatients(db, c.pmMock.practiceId, data);
    out.push({ practiceId: c.pmMock.practiceId, patients: data.patients.length });
  }
  return out;
}
