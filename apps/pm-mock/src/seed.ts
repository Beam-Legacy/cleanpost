/**
 * Loads the synthetic world's mock-PM practices (packages/seed world.ts): accounts with keys derived
 * from PM_MOCK_SECRET, practices, providers, locations and generated patients and encounters.
 * Idempotent: practices that already have data are skipped.
 */
import { CLIENTS, PAYERS, npi, pmLocationId } from '@cleanpost/seed/world';
import { generatePractice } from '@cleanpost/testing/synth';
import type { PmDb } from './db';
import { apiKeyFor } from './keys';
import { loadPractice, upsertAccount, upsertPractice } from './load';
import type { ProfileKey } from './schema';

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
    const data = generatePractice({
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
      asOf: opts.asOf,
    });
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
