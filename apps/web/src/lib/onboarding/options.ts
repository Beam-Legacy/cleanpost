/**
 * Choices the onboarding wizard offers (O-01, O-03, O-06), shared by its pages and server actions.
 * In local and preview the PM cards connect to Cleanpost's mock PM running that PM's limits
 * (DEC-27); real PM connections come with each adapter's credential form.
 */
import type { ProfileKey } from '@cleanpost/adapters';

export const TIME_ZONES = [
  { id: 'America/New_York', label: 'Eastern (New York)' },
  { id: 'America/Chicago', label: 'Central (Chicago)' },
  { id: 'America/Denver', label: 'Mountain (Denver)' },
  { id: 'America/Phoenix', label: 'Mountain, no daylight saving (Phoenix)' },
  { id: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { id: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
] as const;
export type TimeZoneId = (typeof TIME_ZONES)[number]['id'];
export const TIME_ZONE_IDS = TIME_ZONES.map((t) => t.id) as [TimeZoneId, ...TimeZoneId[]];

export interface PmChoice {
  key: 'tebra' | 'advancedmd' | 'manual';
  pmName: string;
  maker: string;
  adapterKey: 'mock' | 'manual';
  profile: ProfileKey;
  note: string;
  /** Connects to the mock PM, so it is offered only where the mock PM runs. */
  demo: boolean;
}

export const PM_CHOICES: PmChoice[] = [
  {
    key: 'tebra',
    pmName: 'Tebra',
    maker: 'Formerly Kareo',
    adapterKey: 'mock',
    profile: 'tebra',
    note: "Charges wait in Tebra's encounter review until Cleanpost releases them. Tebra's API has no remittance files, so 835s are uploaded.",
    demo: true,
  },
  {
    key: 'advancedmd',
    pmName: 'AdvancedMD',
    maker: 'AdvancedMD',
    adapterKey: 'mock',
    profile: 'managed_api',
    note: 'Reads through a managed API. Charges cannot be held, so Cleanpost checks them as the PM sends them; corrections are manual for now.',
    demo: true,
  },
  {
    key: 'manual',
    pmName: 'Other PM',
    maker: 'No integration yet',
    adapterKey: 'manual',
    profile: 'manual',
    note: 'Charges come by file export. Where there is no integration, Cleanpost prepares the work and a biller completes it in the PM.',
    demo: false,
  },
];

export const pmChoice = (key: string) => PM_CHOICES.find((c) => c.key === key);

/**
 * The payers a demo practice bills, as its PM names them: some match a payer's name or alias,
 * some need a person to choose (O-06).
 */
export const DEMO_PM_PAYERS = [
  { name: 'MEDICARE PART B', kind: 'medicare' },
  { name: 'Regence BCBS', kind: 'commercial' },
  { name: 'AETNA', kind: 'commercial' },
  { name: 'UHC', kind: 'commercial' },
  { name: 'PROV HLTH PLN', kind: 'commercial' },
] as const;

/** O-06 default when a payer has no limit set yet: 365 days for Medicare and Medicaid, else 90. */
export function defaultFilingDays(payerName: string): number {
  return /medicare|medicaid|oregon health plan|noridian/i.test(payerName) ? 365 : 90;
}

export const REVIEW_EVERYTHING_DAYS = 14;
