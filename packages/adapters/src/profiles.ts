/**
 * Capability profiles: what each PM lets Cleanpost do, per operation (docs/05-adapters.md).
 * The mock PM (apps/pm-mock) runs one of these profiles per practice so the whole cycle is tested
 * against a PM as limited as the real one.
 */
import type { CapabilityMap, Operation } from './contract';

export const OPERATIONS: Operation[] = [
  'pullPatientsAndCoverage',
  'pullCharges',
  'pullClaimsAndStatus',
  'pullRemittances',
  'pullPostings',
  'holdCharge',
  'releaseCharge',
  'markChargeBilled',
  'pushChargeCorrection',
  'postPayment',
];

/** Every operation at the official API level. */
export const GENERIC_PROFILE: CapabilityMap = Object.fromEntries(
  OPERATIONS.map((o) => [o, 4]),
) as CapabilityMap;

/** Expected Tebra capabilities from its April 2026 API guide and WSDL (docs/05-adapters.md). */
export const TEBRA_PROFILE: CapabilityMap = {
  pullPatientsAndCoverage: 4,
  pullCharges: 4,
  pullClaimsAndStatus: 4,
  pullRemittances: 3, // 835 by file upload: Tebra's API has no ERAs
  pullPostings: 4,
  holdCharge: 4, // encounters wait in Review
  releaseCharge: 4, // UpdateEncounterStatus -> Approved
  markChargeBilled: 'unavailable',
  pushChargeCorrection: 0,
  postPayment: 0,
};

/** A PM reached through a managed third-party API (e.g. AdvancedMD in the synthetic world). */
export const MANAGED_API_PROFILE: CapabilityMap = {
  ...GENERIC_PROFILE,
  pullPatientsAndCoverage: 2,
  pullCharges: 2,
  pullClaimsAndStatus: 2,
  pullRemittances: 2,
  pullPostings: 2,
  holdCharge: 'unavailable',
  releaseCharge: 'unavailable',
  pushChargeCorrection: 0,
  postPayment: 4,
};

/** No integration: charges by file, everything else is a manual task or not possible by hand. */
export const MANUAL_PROFILE: CapabilityMap = {
  pullPatientsAndCoverage: 3,
  pullCharges: 3,
  pullClaimsAndStatus: 0,
  pullRemittances: 3,
  pullPostings: 0,
  holdCharge: 'unavailable',
  releaseCharge: 'unavailable',
  markChargeBilled: 0,
  pushChargeCorrection: 0,
  postPayment: 0,
};

export const PROFILES = {
  generic: GENERIC_PROFILE,
  tebra: TEBRA_PROFILE,
  managed_api: MANAGED_API_PROFILE,
  manual: MANUAL_PROFILE,
} as const;

export type ProfileKey = keyof typeof PROFILES;

const LEVEL_LABEL = {
  4: 'Official API',
  3: 'File',
  2: 'Managed API',
  1: 'Browser automation',
  0: 'Manual',
} as const;

export function levelLabel(level: CapabilityMap[Operation]): string {
  return level === 'unavailable' ? 'Not available' : LEVEL_LABEL[level];
}

/** Plain-language operation names used in I-02 and O-03. */
export const OPERATION_LABEL: Record<Operation, string> = {
  pullPatientsAndCoverage: 'Read patients and coverage',
  pullCharges: 'Read charges',
  pullClaimsAndStatus: 'Read claim status',
  pullRemittances: 'Read payments (835)',
  pullPostings: 'Read what was posted',
  holdCharge: 'Hold charges',
  releaseCharge: 'Release charges',
  markChargeBilled: 'Mark charges billed',
  pushChargeCorrection: 'Write charge corrections',
  postPayment: 'Post payments',
};

/** The best way in: the highest level among the read operations, for list summaries (I-01). */
export function summaryLevel(levels: Partial<CapabilityMap>): string {
  const reads = ['pullCharges', 'pullPatientsAndCoverage'] as const;
  const best = Math.max(...reads.map((o) => (typeof levels[o] === 'number' ? (levels[o] as number) : -1)));
  return best < 0 ? 'Manual' : LEVEL_LABEL[best as 0 | 1 | 2 | 3 | 4];
}
