/**
 * The simulated payers' behaviour (docs/12-testing.md "Payer simulator"): a fee schedule stand-in,
 * filing limits, prior authorization lists and how they pay. Keyed by the payer IDs the seed gives
 * the synthetic payers (SIM_PAYER_IDS in packages/seed/src/world.ts). Synthetic behaviour only;
 * real payers' contracts are not modelled.
 */

export type PayerKind = 'medicare' | 'medicaid' | 'commercial';

export interface PayerProfile {
  id: string;
  name: string;
  kind: PayerKind;
  /** Allowed amount as a percent of billed charges, before the per-code variation. */
  allowedPercent: number;
  /** Days from the date of service the payer accepts a claim. */
  timelyFilingDays: number;
  /** Procedure codes the payer requires prior authorization for. */
  authRequired: readonly string[];
  /** How the payer pays: EFT or paper check. */
  method: 'ACH' | 'CHK';
  /** Prompt-pay interest (PLB L6) when payment comes this many days or more after receipt. */
  interestAfterDays: number | null;
}

const COMMERCIAL_AUTH = ['29881', '73721', '73221'];

export const PAYERS: Record<string, PayerProfile> = Object.fromEntries(
  (
    [
      ['SIMMCRJF', 'Medicare (Noridian JF)', 'medicare', 55, 365, [], 'ACH', null],
      ['SIMREGNC', 'Regence BlueCross BlueShield', 'commercial', 70, 365, COMMERCIAL_AUTH, 'ACH', 18],
      ['SIMOHPMC', 'Oregon Health Plan', 'medicaid', 45, 365, ['29881'], 'CHK', null],
      ['SIMUHC', 'UnitedHealthcare', 'commercial', 75, 90, COMMERCIAL_AUTH, 'ACH', 18],
      ['SIMAETNA', 'Aetna', 'commercial', 72, 120, COMMERCIAL_AUTH, 'ACH', 18],
      ['SIMCIGNA', 'Cigna', 'commercial', 74, 90, COMMERCIAL_AUTH, 'ACH', null],
      ['SIMMODA', 'Moda Health', 'commercial', 68, 180, COMMERCIAL_AUTH, 'CHK', null],
      ['SIMPACSRC', 'PacificSource', 'commercial', 66, 180, COMMERCIAL_AUTH, 'ACH', 18],
      ['SIMPROV', 'Providence Health Plan', 'commercial', 70, 180, COMMERCIAL_AUTH, 'ACH', null],
    ] as const
  ).map(([id, name, kind, allowedPercent, timelyFilingDays, authRequired, method, interestAfterDays]) => [
    id,
    { id, name, kind, allowedPercent, timelyFilingDays, authRequired, method, interestAfterDays },
  ]),
);

/** A payer the simulator has no profile for pays like an average commercial plan. */
export function payerProfile(id: string | null | undefined, name: string): PayerProfile {
  return (
    (id ? PAYERS[id] : undefined) ??
    Object.values(PAYERS).find((p) => p.name === name) ?? {
      id: id ?? 'SIMOTHER',
      name,
      kind: 'commercial',
      allowedPercent: 70,
      timelyFilingDays: 180,
      authRequired: COMMERCIAL_AUTH,
      method: 'ACH',
      interestAfterDays: null,
    }
  );
}

/** FNV-1a: stable choices from IDs, so replays and tests agree. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 7 to 20 days from acceptance to payment, stable for the same claim. */
export function adjudicationDelayDays(id: string): number {
  return 7 + (hash(`adj:${id}`) % 14);
}
