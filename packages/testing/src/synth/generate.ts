/**
 * Synthetic practice generator (docs/12-testing.md). Deterministic for a given seed: patients and
 * coverage drawn from the synthetic identity pools, and encounters from a specialty profile with
 * deliberate defects at known rates. The answer key says which records carry which defect, so
 * scrub accuracy and denial handling can be measured. Every value is invented.
 *
 * Output records have the shape of the adapter contract's ExtPatient and ExtEncounter, so pm-mock
 * can serve them and tests can compare what Cleanpost stored against what was generated.
 */
import { SYNTHETIC_FIRST_NAMES, SYNTHETIC_LAST_NAMES, syntheticMemberId } from './identifiers';
import { createRng, type Rng } from './prng';
import { SPECIALTY_PROFILES, type SpecialtyKey, type VisitTemplate } from './profiles';

export type PayerKind = 'medicare' | 'medicaid' | 'commercial';
export type Sex = 'M' | 'F' | 'U';
export type DefectKind =
  'missing_modifier' | 'invalid_pointer' | 'ncci_conflict' | 'duplicate' | 'missing_prior_auth';

export interface DefectRates {
  missingModifier: number;
  invalidPointer: number;
  ncciConflict: number;
  duplicate: number;
}

export interface CoverageRates {
  /** Coverage the payer would report inactive on the date of service; the PM does not know. */
  inactive: number;
  secondary: number;
  /** The patient's real payer differs from the one on file in the PM. */
  payerMismatch: number;
}

export const DEFAULT_DEFECT_RATES: DefectRates = {
  missingModifier: 0.05,
  invalidPointer: 0.01,
  ncciConflict: 0.02,
  duplicate: 0.005,
};

export const DEFAULT_COVERAGE_RATES: CoverageRates = { inactive: 0.1, secondary: 0.08, payerMismatch: 0.03 };

export interface PracticeInput {
  seed: string;
  /** Prefix for the PM's external IDs, e.g. "LFM". */
  idPrefix: string;
  specialty: SpecialtyKey;
  city: string;
  state: string;
  zips: string[];
  areaCode: string;
  providers: { npi: string }[];
  locations: { externalId: string; placeOfService: string }[];
  payers: { name: string; kind: PayerKind }[];
  patients: number;
  encounters: number;
  /** Dates are generated relative to this day. */
  asOf: Date;
  /** Dates of service fall within this many days before asOf. Default 60. */
  windowDays?: number;
  defectRates?: Partial<DefectRates>;
  coverageRates?: Partial<CoverageRates>;
}

export interface SynthCoverage {
  externalId: string;
  payerName: string;
  priority: 1 | 2 | 3;
  memberId: string;
  groupNumber?: string;
  relationship: 'self' | 'spouse' | 'child' | 'other';
  subscriber?: { firstName: string; lastName: string; dob: string; sex: Sex };
  effectiveDate?: string;
  terminationDate?: string;
}

export interface SynthPatient {
  externalId: string;
  firstName: string;
  lastName: string;
  dob: string;
  sex: Sex;
  address: { line1: string; city: string; state: string; zip: string };
  phone: string;
  coverages: SynthCoverage[];
  updatedAt: string;
}

export interface SynthLine {
  externalId: string;
  code: string;
  modifiers: string[];
  units: number;
  chargeCents: number;
  diagnosisPointers: number[];
}

export interface SynthEncounter {
  externalId: string;
  patientExternalId: string;
  dateOfService: string;
  renderingProviderNpi: string;
  locationExternalId: string;
  placeOfService: string;
  priorAuthNumber?: string;
  diagnoses: { sequence: number; icd10: string }[];
  lines: SynthLine[];
  status: 'open' | 'ready' | 'billed' | 'void';
  updatedAt: string;
}

export interface AnswerKey {
  /** Encounter external ID -> the defects it carries. */
  encounters: Record<string, DefectKind[]>;
  /** For duplicates: duplicate external ID -> original external ID. */
  duplicateOf: Record<string, string>;
  coverages: Record<string, { inactive?: true; actualPayerName?: string }>;
}

export interface SynthPractice {
  patients: SynthPatient[];
  encounters: SynthEncounter[];
  answerKey: AnswerKey;
}

const STREETS = [
  'Alder',
  'Birch',
  'Cedar',
  'Fern',
  'Hawthorn',
  'Juniper',
  'Maple',
  'Oak',
  'Spruce',
  'Willow',
];
const SUFFIXES = ['St', 'Ave', 'Ln', 'Ct', 'Dr', 'Way'];
const MIN_DOB_YEAR = 1930;
const MAX_DOB_YEAR = 2015;
const DAY_MS = 86_400_000;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, '0');

function dobFor(rng: Rng, asOf: Date, ages: [number, number]): string {
  const year = Math.min(
    MAX_DOB_YEAR,
    Math.max(MIN_DOB_YEAR, asOf.getUTCFullYear() - rng.int(ages[0], ages[1])),
  );
  return `${year}-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`;
}

const ageAt = (dob: string, asOf: Date) => asOf.getUTCFullYear() - Number(dob.slice(0, 4));

/** Picks exactly round(rate * n) distinct indices from [0, n). */
function exactSample(rng: Rng, n: number, rate: number, exclude: Set<number> = new Set()): Set<number> {
  const want = Math.round(n * rate);
  const pool = rng.shuffle([...Array(n).keys()].filter((i) => !exclude.has(i)));
  return new Set(pool.slice(0, want));
}

function generatePatients(input: PracticeInput, rng: Rng, answerKey: AnswerKey): SynthPatient[] {
  const profile = SPECIALTY_PROFILES[input.specialty];
  const rates = { ...DEFAULT_COVERAGE_RATES, ...input.coverageRates };
  const byKind = (k: PayerKind) => input.payers.filter((p) => p.kind === k);
  const commercial = byKind('commercial');
  if (commercial.length === 0) throw new Error('a practice needs at least one commercial payer');
  const memberBase = rng.int(10_000_000, 89_999_999);
  let memberSeq = 0;
  let coverageSeq = 0;

  const secondary = exactSample(rng, input.patients, rates.secondary);
  const inactive = exactSample(rng, input.patients, rates.inactive);
  const mismatch = exactSample(rng, input.patients, rates.payerMismatch, inactive);

  const patients: SynthPatient[] = [];
  for (let i = 0; i < input.patients; i++) {
    const lastName = rng.pick(SYNTHETIC_LAST_NAMES);
    const dob = dobFor(rng, input.asOf, profile.ages);
    const age = ageAt(dob, input.asOf);
    const sex: Sex = rng.chance(0.5) ? 'F' : 'M';
    const isChild = age < 18;
    const subscriber = isChild
      ? {
          firstName: rng.pick(SYNTHETIC_FIRST_NAMES),
          lastName,
          dob: dobFor(rng, input.asOf, [32, 55]),
          sex: (rng.chance(0.5) ? 'F' : 'M') as Sex,
        }
      : undefined;

    const primaryPayer =
      age >= 65 && byKind('medicare').length
        ? rng.pick(byKind('medicare'))
        : byKind('medicaid').length && rng.chance(0.2)
          ? rng.pick(byKind('medicaid'))
          : rng.pick(commercial);
    const coverage = (payer: { name: string; kind: PayerKind }, priority: 1 | 2): SynthCoverage => ({
      externalId: `${input.idPrefix}-C${String(++coverageSeq + 10_000)}`,
      payerName: payer.name,
      priority,
      memberId: syntheticMemberId(memberBase + memberSeq++),
      ...(payer.kind === 'commercial' ? { groupNumber: `G${rng.int(10_000, 99_999)}` } : {}),
      relationship: isChild ? 'child' : 'self',
      ...(subscriber ? { subscriber } : {}),
      effectiveDate: `${input.asOf.getUTCFullYear() - rng.int(0, 5)}-01-01`,
    });
    const coverages = [coverage(primaryPayer, 1)];
    if (secondary.has(i)) {
      const others = input.payers.filter((p) => p.name !== primaryPayer.name && p.kind !== 'medicare');
      if (others.length) coverages.push(coverage(rng.pick(others), 2));
    }
    const primary = coverages[0]!;
    if (inactive.has(i)) answerKey.coverages[primary.externalId] = { inactive: true };
    if (mismatch.has(i)) {
      const others = input.payers.filter((p) => p.name !== primary.payerName);
      if (others.length) answerKey.coverages[primary.externalId] = { actualPayerName: rng.pick(others).name };
    }

    patients.push({
      externalId: `${input.idPrefix}-P${String(i + 10_001)}`,
      firstName: rng.pick(SYNTHETIC_FIRST_NAMES),
      lastName,
      dob,
      sex,
      address: {
        line1: `${rng.int(100, 9_899)} ${rng.pick(STREETS)} ${rng.pick(SUFFIXES)}`,
        city: input.city,
        state: input.state,
        zip: rng.pick(input.zips),
      },
      // 555-0100 to 555-0199 is reserved for fiction.
      phone: `${input.areaCode}-555-01${pad(rng.int(0, 99))}`,
      coverages,
      updatedAt: new Date(input.asOf.getTime() - rng.int(30, 400) * DAY_MS).toISOString(),
    });
  }
  return patients;
}

function statusFor(rng: Rng, daysAgo: number): SynthEncounter['status'] {
  if (rng.chance(0.01)) return 'void';
  if (daysAgo > 21) return 'billed';
  if (daysAgo > 7) return rng.chance(0.85) ? 'billed' : 'ready';
  if (daysAgo >= 2) return 'ready';
  return rng.chance(0.5) ? 'open' : 'ready';
}

interface Draft {
  dos: Date;
  template: VisitTemplate;
  defects: DefectKind[];
}

export function generatePractice(input: PracticeInput): SynthPractice {
  if (input.providers.length === 0) throw new Error('a practice needs at least one provider');
  if (input.locations.length === 0) throw new Error('a practice needs at least one location');
  const root = createRng(input.seed);
  const answerKey: AnswerKey = { encounters: {}, duplicateOf: {}, coverages: {} };
  const patients = generatePatients(input, root.fork('patients'), answerKey);
  if (patients.length === 0) return { patients, encounters: [], answerKey };

  const rng = root.fork('encounters');
  const profile = SPECIALTY_PROFILES[input.specialty];
  const rates = { ...DEFAULT_DEFECT_RATES, ...input.defectRates };
  const windowDays = input.windowDays ?? 60;
  const posAvailable = new Set(input.locations.map((l) => l.placeOfService));
  const visits = profile.visits.filter((v) => !v.placeOfService || posAvailable.has(v.placeOfService));

  const duplicates = Math.round(input.encounters * rates.duplicate);
  const originals = input.encounters - duplicates;
  const missing = exactSample(rng, originals, rates.missingModifier);
  const ncci = exactSample(rng, originals, rates.ncciConflict, missing);
  const pointer = exactSample(rng, originals, rates.invalidPointer, new Set([...missing, ...ncci]));

  const drafts: Draft[] = [];
  for (let i = 0; i < originals; i++) {
    let dos = new Date(input.asOf.getTime() - rng.int(0, windowDays) * DAY_MS);
    const weekday = dos.getUTCDay();
    if (weekday === 0) dos = new Date(dos.getTime() - 2 * DAY_MS);
    if (weekday === 6) dos = new Date(dos.getTime() - DAY_MS);
    const template = missing.has(i)
      ? profile.missingModifier
      : ncci.has(i)
        ? profile.ncciConflict
        : rng.weighted(visits);
    const defects: DefectKind[] = [];
    if (missing.has(i)) defects.push('missing_modifier');
    if (ncci.has(i)) defects.push('ncci_conflict');
    if (pointer.has(i)) defects.push('invalid_pointer');
    drafts.push({ dos, template, defects });
  }
  drafts.sort((a, b) => a.dos.getTime() - b.dos.getTime());

  const encounters: SynthEncounter[] = drafts.map((d, i) => {
    const externalId = `${input.idPrefix}-E${String(i + 10_001)}`;
    const patient = rng.pick(patients);
    const dxCount = rng.int(...d.template.diagnoses.count);
    const pool = rng.shuffle(d.template.diagnoses.pool);
    const diagnoses = pool.slice(0, Math.min(dxCount, pool.length)).map((icd10, k) => ({
      sequence: k + 1,
      icd10,
    }));
    const lines: SynthLine[] = [];
    for (const t of d.template.lines) {
      if (t.probability !== undefined && !rng.chance(t.probability)) continue;
      const units = Array.isArray(t.units) ? rng.int(t.units[0], t.units[1]) : (t.units ?? 1);
      lines.push({
        externalId: `${externalId}-${lines.length + 1}`,
        code: t.code,
        modifiers: [...(t.modifiers ?? [])],
        units,
        chargeCents: t.chargeCents * units,
        // Pointers past the diagnoses actually drawn fall back to the first.
        diagnosisPointers: [...new Set((t.pointers ?? [1]).map((p) => (p <= diagnoses.length ? p : 1)))],
      });
    }
    if (d.defects.includes('invalid_pointer')) {
      lines[lines.length - 1]!.diagnosisPointers = [diagnoses.length + 1];
    }
    const location =
      (d.template.placeOfService &&
        input.locations.find((l) => l.placeOfService === d.template.placeOfService)) ||
      rng.pick(
        input.locations.filter((l) => l.placeOfService !== '24').length
          ? input.locations.filter((l) => l.placeOfService !== '24')
          : input.locations,
      );
    let priorAuthNumber: string | undefined;
    if (d.template.priorAuth !== undefined) {
      if (rng.chance(d.template.priorAuth)) priorAuthNumber = `PA${rng.int(1_000_000, 9_999_999)}`;
      else d.defects.push('missing_prior_auth');
    }
    const daysAgo = Math.floor((input.asOf.getTime() - d.dos.getTime()) / DAY_MS);
    const status = statusFor(rng, daysAgo);
    if (d.defects.length) answerKey.encounters[externalId] = d.defects;
    return {
      externalId,
      patientExternalId: patient.externalId,
      dateOfService: iso(d.dos),
      renderingProviderNpi: rng.pick(input.providers).npi,
      locationExternalId: location.externalId,
      placeOfService: location.placeOfService,
      ...(priorAuthNumber ? { priorAuthNumber } : {}),
      diagnoses,
      lines,
      status,
      updatedAt: new Date(d.dos.getTime() + (status === 'billed' ? 1 : 0.7) * DAY_MS).toISOString(),
    };
  });

  // Duplicates: the same visit entered twice under a new encounter number.
  const dupRng = root.fork('duplicates');
  for (let k = 0; k < duplicates && encounters.length; k++) {
    const original = dupRng.pick(encounters.slice(0, originals));
    const externalId = `${input.idPrefix}-E${String(encounters.length + 10_001)}`;
    encounters.push({
      ...original,
      externalId,
      lines: original.lines.map((l, n) => ({ ...l, externalId: `${externalId}-${n + 1}` })),
      status: original.status === 'void' ? 'ready' : original.status,
      updatedAt: new Date(new Date(original.updatedAt).getTime() + 3_600_000).toISOString(),
    });
    answerKey.encounters[externalId] = ['duplicate'];
    answerKey.duplicateOf[externalId] = original.externalId;
  }

  return { patients, encounters, answerKey };
}
