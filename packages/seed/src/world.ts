/**
 * The synthetic world from ui/CONVENTIONS.md, as data. Every value here is invented. NPIs are
 * synthetic but carry valid check digits so the structural scrub accepts them.
 */
import type { ProfileKey } from '@cleanpost/adapters';
import type { SpecialtyKey } from '@cleanpost/testing/synth';
import { npiFromBase } from '@cleanpost/domain';

export const NORTHWIND = '01a00000-0000-7000-8000-000000000001';
export const HARBOR_RCM = '01a00000-0000-7000-8000-000000000002';

/** Fixed IDs so the seed is idempotent. Payers are global reference rows. */
export const PAYERS = [
  {
    id: '01a00000-0000-7000-8000-0000000000a1',
    name: 'Medicare (Noridian JF)',
    aliases: ['Medicare', 'Noridian'],
    filing: 365,
    kind: 'medicare',
  },
  {
    id: '01a00000-0000-7000-8000-0000000000a2',
    name: 'Regence BlueCross BlueShield',
    aliases: ['Regence', 'Regence BCBS'],
    filing: 365,
    kind: 'commercial',
  },
  {
    id: '01a00000-0000-7000-8000-0000000000a3',
    name: 'Oregon Health Plan',
    aliases: ['OHP'],
    filing: 365,
    kind: 'medicaid',
  },
  {
    id: '01a00000-0000-7000-8000-0000000000a4',
    name: 'UnitedHealthcare',
    aliases: ['UHC'],
    filing: 90,
    kind: 'commercial',
  },
  { id: '01a00000-0000-7000-8000-0000000000a5', name: 'Aetna', aliases: [], filing: 120, kind: 'commercial' },
  { id: '01a00000-0000-7000-8000-0000000000a6', name: 'Cigna', aliases: [], filing: 90, kind: 'commercial' },
  {
    id: '01a00000-0000-7000-8000-0000000000a7',
    name: 'Moda Health',
    aliases: ['Moda'],
    filing: 180,
    kind: 'commercial',
  },
  {
    id: '01a00000-0000-7000-8000-0000000000a8',
    name: 'PacificSource',
    aliases: [],
    filing: 180,
    kind: 'commercial',
  },
  {
    id: '01a00000-0000-7000-8000-0000000000a9',
    name: 'Providence Health Plan',
    aliases: ['Providence'],
    filing: 180,
    kind: 'commercial',
  },
] as const;

export interface WorldClient {
  id: string;
  tenantId: string;
  name: string;
  status: 'onboarding' | 'live' | 'paused';
  mode: 'A' | 'B' | 'C';
  city: string;
  npiBase: string;
  taxId: string;
  pmName: string;
  /** The adapter in preview and local: the mock PM running this profile, or a stub for onboarding. */
  adapterKey: 'mock' | 'manual' | 'athenaone';
  profile: ProfileKey;
  pmAccountRef?: string;
  pmBatchTime?: string;
  providers: { name: string; npiBase: string; taxonomy: string }[];
  locations: { name: string; pos: string }[];
  payerIds: string[];
  onboardingStep?: number;
  /** The practice on the mock PM behind this client (adapterKey 'mock'), loaded by pm-mock's seed. */
  pmMock?: {
    accountId: string;
    accountName: string;
    practiceId: string;
    /** Prefix of the PM's record numbers. Location n is `${idPrefix}-L${n}`. */
    idPrefix: string;
    specialty: SpecialtyKey;
    patients: number;
    encounters: number;
    zips: string[];
    areaCode: string;
  };
}

/** The PM's ID for a client's nth location (1-based), shared by both seeds. */
export const pmLocationId = (c: WorldClient, n: number) => `${c.pmMock!.idPrefix}-L${n}`;

/** Secret reference the development resolver turns into the mock PM account's API key. */
export const pmMockSecretRef = (c: WorldClient) => `pm-mock:${c.pmMock!.accountId}`;

const p = PAYERS.map((x) => x.id);

export const CLIENTS: WorldClient[] = [
  {
    id: '01a00000-0000-7000-8000-0000000000c1',
    tenantId: NORTHWIND,
    name: 'Lakeside Family Medicine',
    status: 'live',
    mode: 'A',
    city: 'Portland',
    npiBase: '148772659',
    taxId: '93-2041187',
    pmName: 'Tebra',
    adapterKey: 'mock',
    profile: 'tebra',
    pmAccountRef: 'tebra:northwind-billing',
    pmBatchTime: '18:00',
    pmMock: {
      accountId: 'northwind-billing',
      accountName: 'Northwind Billing (Tebra account)',
      practiceId: 'lakeside',
      idPrefix: 'LFM',
      specialty: 'family_medicine',
      patients: 180,
      encounters: 320,
      zips: ['97201', '97205', '97209', '97214'],
      areaCode: '503',
    },
    providers: [
      { name: 'Dr. Elena Ruiz', npiBase: '193220441', taxonomy: '207Q00000X' },
      { name: 'Dr. Samuel Okonkwo', npiBase: '176803392', taxonomy: '207Q00000X' },
    ],
    locations: [{ name: 'Lakeside main clinic', pos: '11' }],
    payerIds: [p[0]!, p[1]!, p[3]!, p[4]!, p[5]!, p[8]!],
  },
  {
    id: '01a00000-0000-7000-8000-0000000000c2',
    tenantId: NORTHWIND,
    name: 'Cascade Pediatrics',
    status: 'live',
    // The ui/ designs show Cascade in Mode B; until Modes B and C are built (M7) every Northwind
    // client runs in Mode A (docs/12-testing.md, DEC-01).
    mode: 'A',
    city: 'Salem',
    npiBase: '162945530',
    taxId: '93-3307715',
    pmName: 'AdvancedMD',
    adapterKey: 'mock',
    profile: 'managed_api',
    pmMock: {
      accountId: 'cascade-pediatrics',
      accountName: 'Cascade Pediatrics (AdvancedMD)',
      practiceId: 'cascade',
      idPrefix: 'CPD',
      specialty: 'pediatrics',
      patients: 150,
      encounters: 260,
      zips: ['97301', '97302', '97304', '97303'],
      areaCode: '503',
    },
    providers: [{ name: 'Dr. Grace Whitfield', npiBase: '184417290', taxonomy: '208000000X' }],
    locations: [
      { name: 'Cascade Pediatrics Salem', pos: '11' },
      { name: 'Cascade Pediatrics Keizer', pos: '11' },
    ],
    payerIds: [p[1]!, p[2]!, p[3]!, p[4]!, p[6]!, p[7]!],
  },
  {
    id: '01a00000-0000-7000-8000-0000000000c3',
    tenantId: NORTHWIND,
    name: 'Willamette Ortho',
    status: 'live',
    // Designs show Mode C; Mode A until M7 (see Cascade above).
    mode: 'A',
    city: 'Eugene',
    npiBase: '170052887',
    taxId: '93-1185520',
    pmName: 'Tebra',
    adapterKey: 'mock',
    profile: 'tebra',
    pmAccountRef: 'tebra:northwind-billing',
    pmBatchTime: '18:00',
    pmMock: {
      accountId: 'northwind-billing',
      accountName: 'Northwind Billing (Tebra account)',
      practiceId: 'willamette',
      idPrefix: 'WOR',
      specialty: 'orthopedics',
      patients: 140,
      encounters: 240,
      zips: ['97401', '97403', '97405'],
      areaCode: '541',
    },
    providers: [
      { name: 'Dr. Marcus Thibodeaux', npiBase: '155901273', taxonomy: '207X00000X' },
      { name: 'Dr. Priyanka Rao', npiBase: '126648819', taxonomy: '207X00000X' },
    ],
    locations: [
      { name: 'Willamette Ortho clinic', pos: '11' },
      { name: 'Willamette Surgery Center', pos: '24' },
    ],
    payerIds: [p[0]!, p[1]!, p[3]!, p[4]!, p[5]!, p[6]!],
  },
  {
    id: '01a00000-0000-7000-8000-0000000000c4',
    tenantId: NORTHWIND,
    name: 'Riverbend Counseling',
    status: 'live',
    mode: 'A',
    city: 'Bend',
    npiBase: '138814025',
    taxId: '93-4420961',
    pmName: 'SimplePractice',
    adapterKey: 'manual',
    profile: 'manual',
    providers: [{ name: 'Jordan Ames, LCSW', npiBase: '109937166', taxonomy: '1041C0700X' }],
    locations: [{ name: 'Riverbend office', pos: '11' }],
    payerIds: [p[2]!, p[6]!, p[7]!, p[8]!],
  },
  {
    id: '01a00000-0000-7000-8000-0000000000c5',
    tenantId: NORTHWIND,
    name: 'Harbor Dermatology',
    status: 'onboarding',
    mode: 'A',
    city: 'Newport',
    npiBase: '145528703',
    taxId: '93-5532018',
    pmName: 'athenaOne',
    adapterKey: 'athenaone',
    profile: 'manual',
    providers: [{ name: 'Dr. Naomi Castellanos', npiBase: '160447218', taxonomy: '207N00000X' }],
    locations: [{ name: 'Harbor Dermatology', pos: '11' }],
    payerIds: [p[1]!, p[3]!, p[4]!],
    onboardingStep: 4,
  },
  {
    id: '01a00000-0000-7000-8000-0000000000d1',
    tenantId: HARBOR_RCM,
    name: 'Seaside Physical Therapy',
    status: 'live',
    mode: 'A',
    city: 'Astoria',
    npiBase: '118230456',
    taxId: '93-6610042',
    pmName: 'Office Ally',
    adapterKey: 'manual',
    profile: 'manual',
    providers: [{ name: 'Lena Fairbanks, PT', npiBase: '133390871', taxonomy: '225100000X' }],
    locations: [{ name: 'Seaside PT', pos: '11' }],
    payerIds: [p[0]!, p[2]!, p[3]!],
  },
];

export const npi = npiFromBase;
