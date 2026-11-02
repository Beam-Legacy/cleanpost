/**
 * Check 2, "posting match" (docs/07-remittance-posting.md), for Modes A and C where the PM posts:
 * per 835 line, what the PM should show (paid, each adjustment in the PM's own code, patient
 * responsibility) against what it posted. Denials post no adjustment: the balance stays open for
 * the denial queue, so a denial the PM wrote off is a difference. Amounts in cents, codes only.
 */
import { formatCents } from '../money';
import type { Adjustment, GroupCode, ServiceLinePayment } from './types';
import { isDenialAdjustment } from './outcome';

export type MappingAction = 'adjust' | 'transfer_to_patient' | 'write_off' | 'info_only';

export interface AdjustmentMapping {
  pmAdjustmentCode: string;
  action: MappingAction;
}

export type MappingLookup = (group: GroupCode, carc: string) => AdjustmentMapping | null;

/**
 * Defaults for every PM type until a tenant maps its own codes (they are the mock PM's codes; a real
 * PM's are set per tenant and PM type in adjustment_mappings, and clients can override).
 */
export const DEFAULT_ADJUSTMENT_MAPPINGS: Readonly<Record<string, AdjustmentMapping>> = {
  'CO-45': { pmAdjustmentCode: 'CONTR', action: 'write_off' },
  'CO-253': { pmAdjustmentCode: 'CONTR', action: 'write_off' },
  'PR-1': { pmAdjustmentCode: 'DEDUCT', action: 'transfer_to_patient' },
  'PR-2': { pmAdjustmentCode: 'COINS', action: 'transfer_to_patient' },
  'PR-3': { pmAdjustmentCode: 'COPAY', action: 'transfer_to_patient' },
};

export interface PmLinePosting {
  paidCents: number;
  adjustments: { pmAdjustmentCode: string; amountCents: number }[];
  patientRespCents: number;
}

export interface Difference {
  field: string;
  expected: string;
  actual: string;
}

export type LineVerification =
  | { status: 'verified' }
  | { status: 'missing' }
  | { status: 'unmapped'; pairs: string[] }
  | { status: 'mismatch'; differences: Difference[] };

export interface ExpectedPosting {
  paidCents: number;
  /** PM adjustment code -> total cents. */
  adjustments: Map<string, number>;
  patientRespCents: number;
  /** Denied on this line: no adjustment expected, the balance stays open. */
  deniedCents: number;
  /** Group-CARC pairs with no mapping (and not denials). */
  unmapped: string[];
}

export function expectedPosting(line: ServiceLinePayment, lookup: MappingLookup): ExpectedPosting {
  const out: ExpectedPosting = {
    paidCents: line.paidCents,
    adjustments: new Map(),
    patientRespCents: 0,
    deniedCents: 0,
    unmapped: [],
  };
  const add = (code: string, cents: number) =>
    out.adjustments.set(code, (out.adjustments.get(code) ?? 0) + cents);
  for (const a of line.adjustments) {
    if (a.group === 'PR') out.patientRespCents += a.amountCents;
    const m = lookup(a.group, a.carc);
    if (m) {
      if (m.action !== 'info_only') add(m.pmAdjustmentCode, a.amountCents);
      continue;
    }
    if (isDenialAdjustment(a) || isDenialAdjustment({ ...a, amountCents: -a.amountCents })) {
      out.deniedCents += a.amountCents;
      continue;
    }
    out.unmapped.push(`${a.group}-${a.carc}`);
  }
  return out;
}

const money = (cents: number | undefined) =>
  cents === undefined || cents === 0 ? 'none' : formatCents(cents);

export function verifyLine(
  line: ServiceLinePayment,
  posted: readonly PmLinePosting[],
  lookup: MappingLookup,
): LineVerification {
  const want = expectedPosting(line, lookup);
  if (want.unmapped.length) return { status: 'unmapped', pairs: [...new Set(want.unmapped)] };
  if (!posted.length) return { status: 'missing' };
  const actual = new Map<string, number>();
  let paid = 0;
  let patient = 0;
  for (const p of posted) {
    paid += p.paidCents;
    patient += p.patientRespCents;
    for (const a of p.adjustments)
      actual.set(a.pmAdjustmentCode, (actual.get(a.pmAdjustmentCode) ?? 0) + a.amountCents);
  }
  const differences: Difference[] = [];
  if (paid !== want.paidCents)
    differences.push({ field: 'Paid', expected: money(want.paidCents), actual: money(paid) });
  const extra = [...actual.entries()].filter(([code, cents]) => cents !== (want.adjustments.get(code) ?? 0));
  const writtenOff =
    want.deniedCents !== 0 &&
    extra.reduce((s, [code, c]) => s + c - (want.adjustments.get(code) ?? 0), 0) === want.deniedCents;
  if (writtenOff) {
    differences.push({ field: 'Denial written off', expected: 'left open', actual: money(want.deniedCents) });
  } else {
    for (const code of new Set([...want.adjustments.keys(), ...actual.keys()])) {
      const e = want.adjustments.get(code) ?? 0;
      const a = actual.get(code) ?? 0;
      if (e !== a) differences.push({ field: `Adjustment ${code}`, expected: money(e), actual: money(a) });
    }
  }
  if (patient !== want.patientRespCents)
    differences.push({
      field: 'Patient responsibility',
      expected: money(want.patientRespCents),
      actual: money(patient),
    });
  return differences.length ? { status: 'mismatch', differences } : { status: 'verified' };
}

/** Lookup over client overrides, then tenant defaults for the PM type, then the built-in defaults. */
export function mappingLookup(
  rows: readonly {
    clientId: string | null;
    groupCode: string;
    carc: string;
    pmAdjustmentCode: string;
    action: string;
  }[],
  clientId: string,
): MappingLookup {
  const own = new Map<string, AdjustmentMapping>();
  const tenant = new Map<string, AdjustmentMapping>();
  for (const r of rows) {
    const m = { pmAdjustmentCode: r.pmAdjustmentCode, action: r.action as MappingAction };
    (r.clientId === clientId ? own : r.clientId === null ? tenant : null)?.set(`${r.groupCode}-${r.carc}`, m);
  }
  return (group, carc) => {
    const k = `${group}-${carc}`;
    return own.get(k) ?? tenant.get(k) ?? DEFAULT_ADJUSTMENT_MAPPINGS[k] ?? null;
  };
}

export type { Adjustment };
