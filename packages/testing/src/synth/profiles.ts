/**
 * Specialty profiles for the encounter generator (docs/12-testing.md): visit mix, codes, modifiers,
 * diagnoses and charge amounts. Codes only, never CPT descriptions (CLAUDE.md rule 11). Charge
 * amounts are an invented fee schedule in integer cents.
 *
 * Each profile also names the visits that carry its deliberate defects, so the scrubber (M2) can be
 * measured against a known answer key. The NCCI pairs used here are real procedure-to-procedure
 * edits; M2 checks them against the CMS tables, not against this file.
 *
 * The pilot specialty is still to be chosen (docs/17-decisions.md); these three back the synthetic
 * practices on the mock PM.
 */

export interface LineTemplate {
  code: string;
  chargeCents: number;
  modifiers?: string[];
  /** Fixed units, or a range. */
  units?: number | [number, number];
  /** Probability the line is present at all; default 1. */
  probability?: number;
  /** Diagnosis pointers by position in the visit's diagnoses (1-based); default [1]. */
  pointers?: number[];
}

export interface VisitTemplate {
  key: string;
  weight: number;
  lines: LineTemplate[];
  /** ICD-10 codes to draw this visit's diagnoses from, and how many. */
  diagnoses: { pool: string[]; count: [number, number] };
  /** Place of service this visit needs; picks a matching location, or is skipped when none exists. */
  placeOfService?: string;
  /** Probability the visit has a prior authorization number (procedures that need one). */
  priorAuth?: number;
}

export interface SpecialtyProfile {
  key: SpecialtyKey;
  /** Patient ages, in years at the as-of date. Clamped to the synthetic DOB range (1930-2015). */
  ages: [number, number];
  visits: VisitTemplate[];
  /** An E/M with a same-day procedure, modifier 25 left off. */
  missingModifier: VisitTemplate;
  /** Two codes that form an NCCI procedure-to-procedure edit, with no modifier to bypass it. */
  ncciConflict: VisitTemplate;
}

export type SpecialtyKey = 'family_medicine' | 'pediatrics' | 'orthopedics';

const FM_CHRONIC = ['I10', 'E11.9', 'E78.5', 'K21.9', 'M54.50', 'J45.909', 'E03.9', 'F41.1'];
const FM_ACUTE = ['J06.9', 'J02.9', 'R05.9', 'N39.0', 'J01.90', 'R51.9'];

export const FAMILY_MEDICINE: SpecialtyProfile = {
  key: 'family_medicine',
  ages: [18, 88],
  visits: [
    {
      key: 'est-low',
      weight: 38,
      lines: [{ code: '99213', chargeCents: 13_500 }],
      diagnoses: { pool: [...FM_CHRONIC, ...FM_ACUTE], count: [1, 2] },
    },
    {
      key: 'est-moderate',
      weight: 24,
      lines: [{ code: '99214', chargeCents: 19_500, pointers: [1, 2] }],
      diagnoses: { pool: FM_CHRONIC, count: [2, 3] },
    },
    {
      key: 'est-straightforward',
      weight: 8,
      lines: [{ code: '99212', chargeCents: 8_500 }],
      diagnoses: { pool: FM_ACUTE, count: [1, 1] },
    },
    {
      key: 'est-high',
      weight: 4,
      lines: [{ code: '99215', chargeCents: 27_500, pointers: [1, 2, 3] }],
      diagnoses: { pool: FM_CHRONIC, count: [3, 4] },
    },
    {
      key: 'new-low',
      weight: 5,
      lines: [{ code: '99203', chargeCents: 17_000 }],
      diagnoses: { pool: [...FM_CHRONIC, ...FM_ACUTE], count: [1, 2] },
    },
    {
      key: 'preventive',
      weight: 8,
      lines: [
        { code: '99396', chargeCents: 26_000 },
        { code: '90471', chargeCents: 2_800, probability: 0.4, pointers: [2] },
        { code: '90686', chargeCents: 3_900, probability: 0.4, pointers: [2] },
      ],
      diagnoses: { pool: ['Z00.00', 'Z00.01'], count: [1, 1] },
    },
    {
      key: 'est-with-injection',
      weight: 5,
      lines: [
        { code: '99213', chargeCents: 13_500, modifiers: ['25'], pointers: [2] },
        { code: '20610', chargeCents: 14_500, modifiers: ['RT'] },
        { code: 'J1030', chargeCents: 1_800 },
      ],
      diagnoses: { pool: ['M17.11', 'M25.561', 'I10', 'E11.9'], count: [2, 2] },
    },
    {
      key: 'est-with-ecg',
      weight: 5,
      lines: [
        { code: '99214', chargeCents: 19_500 },
        { code: '93000', chargeCents: 6_500 },
      ],
      diagnoses: { pool: ['R00.2', 'I48.91', 'R07.9', 'I10'], count: [1, 2] },
    },
  ],
  missingModifier: {
    key: 'est-with-injection-no-25',
    weight: 1,
    lines: [
      { code: '99213', chargeCents: 13_500, pointers: [2] },
      { code: '20610', chargeCents: 14_500, modifiers: ['RT'] },
      { code: 'J1030', chargeCents: 1_800 },
    ],
    diagnoses: { pool: ['M17.11', 'M25.561'], count: [2, 2] },
  },
  ncciConflict: {
    key: 'injection-with-ultrasound',
    weight: 1,
    lines: [
      { code: '20610', chargeCents: 14_500, modifiers: ['RT'] },
      { code: '76942', chargeCents: 11_000 },
    ],
    diagnoses: { pool: ['M17.11', 'M25.561'], count: [1, 1] },
  },
};

const PEDS_ACUTE = ['J06.9', 'H66.90', 'J02.9', 'L20.9', 'J45.909', 'R50.9', 'B34.9'];

export const PEDIATRICS: SpecialtyProfile = {
  key: 'pediatrics',
  // The synthetic DOB range ends in 2015 so the log scanner can recognise every DOB.
  ages: [11, 17],
  visits: [
    {
      key: 'est-low',
      weight: 34,
      lines: [{ code: '99213', chargeCents: 12_500 }],
      diagnoses: { pool: PEDS_ACUTE, count: [1, 2] },
    },
    {
      key: 'est-moderate',
      weight: 14,
      lines: [{ code: '99214', chargeCents: 18_000, pointers: [1, 2] }],
      diagnoses: { pool: PEDS_ACUTE, count: [2, 2] },
    },
    {
      key: 'est-straightforward',
      weight: 10,
      lines: [{ code: '99212', chargeCents: 8_000 }],
      diagnoses: { pool: PEDS_ACUTE, count: [1, 1] },
    },
    {
      key: 'well-child',
      weight: 22,
      lines: [
        { code: '99394', chargeCents: 21_000 },
        { code: '96127', chargeCents: 2_500, probability: 0.6, units: [1, 2], pointers: [2] },
        { code: '90460', chargeCents: 3_200, probability: 0.35, pointers: [3] },
        { code: '90651', chargeCents: 29_000, probability: 0.35, pointers: [3] },
      ],
      diagnoses: { pool: ['Z00.129', 'Z13.31', 'Z23'], count: [3, 3] },
    },
    {
      key: 'sick-with-strep-test',
      weight: 12,
      lines: [
        { code: '99213', chargeCents: 12_500 },
        { code: '87880', chargeCents: 3_500, modifiers: ['QW'] },
      ],
      diagnoses: { pool: ['J02.9', 'J02.0', 'R50.9'], count: [1, 2] },
    },
    {
      key: 'well-child-with-problem',
      weight: 8,
      lines: [
        { code: '99394', chargeCents: 21_000 },
        { code: '99213', chargeCents: 12_500, modifiers: ['25'], pointers: [2] },
      ],
      diagnoses: { pool: ['Z00.121', 'J45.909', 'L20.9'], count: [2, 2] },
    },
  ],
  missingModifier: {
    key: 'well-child-with-problem-no-25',
    weight: 1,
    lines: [
      { code: '99394', chargeCents: 21_000 },
      { code: '99213', chargeCents: 12_500, pointers: [2] },
    ],
    diagnoses: { pool: ['Z00.121', 'J45.909', 'L20.9'], count: [2, 2] },
  },
  ncciConflict: {
    key: 'two-admin-codes',
    weight: 1,
    lines: [
      { code: '99394', chargeCents: 21_000 },
      { code: '90460', chargeCents: 3_200, pointers: [2] },
      { code: '90471', chargeCents: 2_800, pointers: [2] },
      { code: '90651', chargeCents: 29_000, pointers: [2] },
    ],
    diagnoses: { pool: ['Z00.129', 'Z23'], count: [2, 2] },
  },
};

const ORTHO_DX = ['M25.561', 'M25.562', 'M17.11', 'M17.12', 'M75.101', 'M54.50', 'M65.4', 'M77.11'];

export const ORTHOPEDICS: SpecialtyProfile = {
  key: 'orthopedics',
  ages: [18, 85],
  visits: [
    {
      key: 'est-low',
      weight: 24,
      lines: [{ code: '99213', chargeCents: 14_000 }],
      diagnoses: { pool: ORTHO_DX, count: [1, 2] },
    },
    {
      key: 'est-moderate',
      weight: 18,
      lines: [{ code: '99214', chargeCents: 20_500 }],
      diagnoses: { pool: ORTHO_DX, count: [1, 2] },
    },
    {
      key: 'new-low',
      weight: 10,
      lines: [{ code: '99203', chargeCents: 18_500 }],
      diagnoses: { pool: ORTHO_DX, count: [1, 2] },
    },
    {
      key: 'est-with-knee-injection',
      weight: 15,
      lines: [
        { code: '99213', chargeCents: 14_000, modifiers: ['25'] },
        { code: '20610', chargeCents: 15_500, modifiers: ['RT'] },
        { code: 'J3301', chargeCents: 600, units: [4, 4] },
      ],
      diagnoses: { pool: ['M17.11', 'M25.561'], count: [1, 1] },
    },
    {
      key: 'shoulder-xray',
      weight: 10,
      lines: [
        { code: '99213', chargeCents: 14_000 },
        { code: '73030', chargeCents: 9_500, modifiers: ['RT'] },
      ],
      diagnoses: { pool: ['M75.101', 'M25.511'], count: [1, 1] },
    },
    {
      key: 'knee-xray',
      weight: 10,
      lines: [
        { code: '99203', chargeCents: 18_500 },
        { code: '73562', chargeCents: 10_500, modifiers: ['LT'] },
      ],
      diagnoses: { pool: ['M25.562', 'M17.12'], count: [1, 1] },
    },
    {
      key: 'tendon-sheath-injection',
      weight: 5,
      lines: [{ code: '20550', chargeCents: 13_000, modifiers: ['RT'] }],
      diagnoses: { pool: ['M65.4', 'M77.11'], count: [1, 1] },
    },
    {
      key: 'knee-arthroscopy',
      weight: 5,
      placeOfService: '24',
      priorAuth: 0.9,
      lines: [{ code: '29881', chargeCents: 425_000, modifiers: ['RT'] }],
      diagnoses: { pool: ['S83.241A', 'S83.242A', 'M23.221'], count: [1, 1] },
    },
  ],
  missingModifier: {
    key: 'est-with-knee-injection-no-25',
    weight: 1,
    lines: [
      { code: '99214', chargeCents: 20_500 },
      { code: '20610', chargeCents: 15_500, modifiers: ['RT'] },
    ],
    diagnoses: { pool: ['M17.11', 'M25.561'], count: [1, 1] },
  },
  ncciConflict: {
    key: 'injection-with-ultrasound',
    weight: 1,
    lines: [
      { code: '20610', chargeCents: 15_500, modifiers: ['RT'] },
      { code: '76942', chargeCents: 11_500 },
    ],
    diagnoses: { pool: ['M17.11', 'M25.561'], count: [1, 1] },
  },
};

export const SPECIALTY_PROFILES: Record<SpecialtyKey, SpecialtyProfile> = {
  family_medicine: FAMILY_MEDICINE,
  pediatrics: PEDIATRICS,
  orthopedics: ORTHOPEDICS,
};
