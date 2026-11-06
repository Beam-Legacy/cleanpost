import { describe, expect, it } from 'vitest';
import {
  DOB_PATTERN,
  SPECIALTY_PROFILES,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
  SYNTHETIC_MEMBER_ID_PATTERN,
  createRng,
  generatePractice,
  type PracticeInput,
} from '../src/synth';

const input = (overrides: Partial<PracticeInput> = {}): PracticeInput => ({
  seed: 'test-practice',
  idPrefix: 'TST',
  specialty: 'family_medicine',
  city: 'Portland',
  state: 'OR',
  zips: ['97201', '97202'],
  areaCode: '503',
  providers: [{ npi: '1932204415' }, { npi: '1768033927' }],
  locations: [{ externalId: 'LOC-1', placeOfService: '11' }],
  payers: [
    { name: 'Medicare', kind: 'medicare' },
    { name: 'Oregon Health Plan', kind: 'medicaid' },
    { name: 'Aetna', kind: 'commercial' },
    { name: 'Cigna', kind: 'commercial' },
  ],
  patients: 200,
  encounters: 400,
  asOf: new Date('2026-10-30T12:00:00Z'),
  ...overrides,
});

describe('createRng', () => {
  it('is reproducible and forks independently', () => {
    const a = createRng('x');
    const b = createRng('x');
    expect([a.next(), a.int(1, 6), a.pick(['p', 'q', 'r'])]).toEqual([
      b.next(),
      b.int(1, 6),
      b.pick(['p', 'q', 'r']),
    ]);
    expect(createRng('x').fork('one').next()).not.toBe(createRng('x').fork('two').next());
  });
});

describe('generatePractice', () => {
  it('is deterministic for a seed', () => {
    expect(generatePractice(input())).toEqual(generatePractice(input()));
    expect(generatePractice(input({ seed: 'other' })).patients[0]).not.toEqual(
      generatePractice(input()).patients[0],
    );
  });

  it('draws identities only from the synthetic pools', () => {
    const { patients } = generatePractice(input());
    for (const p of patients) {
      expect(SYNTHETIC_FIRST_NAMES).toContain(p.firstName);
      expect(SYNTHETIC_LAST_NAMES).toContain(p.lastName);
      expect(p.dob).toMatch(DOB_PATTERN);
      expect(p.phone).toMatch(/^503-555-01\d\d$/);
      for (const c of p.coverages) {
        expect(c.memberId).toMatch(SYNTHETIC_MEMBER_ID_PATTERN);
        if (c.subscriber) expect(c.subscriber.dob).toMatch(DOB_PATTERN);
      }
    }
  });

  it('gives Medicare to patients 65 and over and secondary coverage at the configured rate', () => {
    const { patients } = generatePractice(input());
    for (const p of patients.filter((x) => 2026 - Number(x.dob.slice(0, 4)) >= 65)) {
      expect(p.coverages[0]!.payerName).toBe('Medicare');
    }
    const withSecondary = patients.filter((p) => p.coverages.length === 2).length;
    expect(withSecondary).toBe(Math.round(200 * 0.08));
  });

  it('records coverage problems in the answer key at the configured rates', () => {
    const { answerKey } = generatePractice(input());
    const entries = Object.values(answerKey.coverages);
    expect(entries.filter((e) => e.inactive).length).toBe(20);
    expect(entries.filter((e) => e.actualPayerName).length).toBe(6);
  });

  it('injects encounter defects at exact rates and records them', () => {
    const { encounters, answerKey } = generatePractice(input());
    expect(encounters).toHaveLength(400);
    const count = (kind: string) =>
      Object.values(answerKey.encounters).filter((d) => d.includes(kind as never)).length;
    expect(count('missing_modifier')).toBe(Math.round(398 * 0.05));
    expect(count('ncci_conflict')).toBe(Math.round(398 * 0.02));
    expect(count('invalid_pointer')).toBe(Math.round(398 * 0.01));
    expect(count('duplicate')).toBe(2);
  });

  it('draws defects per visit for small daily batches, where exact counts round to none', () => {
    const day = (k: number, sampling?: 'each') =>
      generatePractice({
        ...input(),
        seed: `day-${k}`,
        encounters: 6,
        windowDays: 0,
        defectRates: { duplicate: 0 },
        ...(sampling ? { defectSampling: sampling } : {}),
      }).answerKey.encounters;
    const missing = (sampling?: 'each') =>
      Array.from({ length: 200 }, (_, k) => day(k, sampling)).reduce(
        (n, enc) => n + Object.values(enc).filter((d) => d.includes('missing_modifier')).length,
        0,
      );
    // 200 days of 6 visits: exact sampling plants none; per visit about 5% of 1,200.
    expect(missing()).toBe(0);
    expect(missing('each')).toBeGreaterThan(30);
    expect(missing('each')).toBeLessThan(95);
  });

  it('makes each defect real in the data', () => {
    const { encounters, answerKey } = generatePractice(input());
    const byId = new Map(encounters.map((e) => [e.externalId, e]));
    for (const [id, defects] of Object.entries(answerKey.encounters)) {
      const e = byId.get(id)!;
      if (defects.includes('invalid_pointer')) {
        expect(e.lines.some((l) => l.diagnosisPointers.some((p) => p > e.diagnoses.length))).toBe(true);
      }
      if (defects.includes('missing_modifier')) {
        const em = e.lines.find((l) => /^992/.test(l.code))!;
        expect(em.modifiers).not.toContain('25');
        expect(e.lines.length).toBeGreaterThan(1);
      }
      if (defects.includes('ncci_conflict')) {
        expect(e.lines.map((l) => l.code)).toEqual(expect.arrayContaining(['20610', '76942']));
      }
      if (defects.includes('duplicate')) {
        const original = byId.get(answerKey.duplicateOf[id]!)!;
        expect(e.patientExternalId).toBe(original.patientExternalId);
        expect(e.dateOfService).toBe(original.dateOfService);
        expect(e.lines.map((l) => l.code)).toEqual(original.lines.map((l) => l.code));
      }
    }
  });

  it('keeps every other pointer valid, money in integer cents and dates of service in the window', () => {
    const { encounters, answerKey, patients } = generatePractice(input());
    const ids = new Set(patients.map((p) => p.externalId));
    for (const e of encounters) {
      expect(ids.has(e.patientExternalId)).toBe(true);
      expect(e.dateOfService >= '2026-08-31' && e.dateOfService <= '2026-10-30').toBe(true);
      expect([0, 6]).not.toContain(new Date(`${e.dateOfService}T00:00:00Z`).getUTCDay());
      for (const l of e.lines) {
        expect(Number.isInteger(l.chargeCents) && l.chargeCents > 0).toBe(true);
        if (!answerKey.encounters[e.externalId]?.includes('invalid_pointer')) {
          for (const p of l.diagnosisPointers) expect(p).toBeLessThanOrEqual(e.diagnoses.length);
        }
      }
    }
    expect(new Set(encounters.map((e) => e.externalId)).size).toBe(encounters.length);
  });

  it('only schedules surgery at a surgery location, usually with prior auth', () => {
    const ortho = generatePractice(
      input({
        specialty: 'orthopedics',
        locations: [
          { externalId: 'CLINIC', placeOfService: '11' },
          { externalId: 'ASC', placeOfService: '24' },
        ],
      }),
    );
    const surgeries = ortho.encounters.filter((e) => e.lines.some((l) => l.code === '29881'));
    expect(surgeries.length).toBeGreaterThan(0);
    for (const s of surgeries) {
      expect(s.locationExternalId).toBe('ASC');
      if (!s.priorAuthNumber)
        expect(ortho.answerKey.encounters[s.externalId]).toContain('missing_prior_auth');
    }
    const office = ortho.encounters.filter((e) => !e.lines.some((l) => l.code === '29881'));
    expect(office.every((e) => e.locationExternalId === 'CLINIC')).toBe(true);
  });

  it('makes pediatric patients dependents with a subscriber', () => {
    const peds = generatePractice(input({ specialty: 'pediatrics', patients: 50, encounters: 60 }));
    for (const p of peds.patients) {
      expect(p.coverages[0]!.relationship).toBe('child');
      expect(p.coverages[0]!.subscriber?.lastName).toBe(p.lastName);
    }
  });

  it('has a profile for each synthetic practice specialty with codes only', () => {
    for (const profile of Object.values(SPECIALTY_PROFILES)) {
      for (const v of [...profile.visits, profile.missingModifier, profile.ncciConflict]) {
        for (const l of v.lines) {
          expect(l.code).toMatch(/^(\d{5}|[A-Z]\d{4})$/);
          expect(Object.keys(l)).not.toContain('description');
        }
      }
    }
  });
});
