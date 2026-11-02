/**
 * Check 1, "835 balance" (docs/07-remittance-posting.md): runs right after parsing, before
 * matching, posting or verification.
 * - Per claim: charge - paid - sum of adjustments (claim and line CAS, all groups) = 0.
 * - Per remittance: sum of claim paid - sum of PLB = BPR payment amount.
 */
import type { ClaimPayment, Remittance835 } from './types';

export interface ClaimBalance {
  patientControlNumber: string;
  differenceCents: number;
}

export interface Balance {
  balanced: boolean;
  /** Claims that do not balance on their own, with the difference. */
  claims: ClaimBalance[];
  /** Sum of claim paid - PLB - BPR amount; 0 when the remittance balances. */
  remittanceDifferenceCents: number;
}

export function claimAdjustmentTotal(c: ClaimPayment): number {
  return (
    c.adjustments.reduce((s, a) => s + a.amountCents, 0) +
    c.lines.reduce((s, l) => s + l.adjustments.reduce((t, a) => t + a.amountCents, 0), 0)
  );
}

export function claimDifference(c: ClaimPayment): number {
  return c.chargeCents - c.paidCents - claimAdjustmentTotal(c);
}

export function balance835(r: Remittance835): Balance {
  const claims = r.claims
    .map((c) => ({ patientControlNumber: c.patientControlNumber, differenceCents: claimDifference(c) }))
    .filter((c) => c.differenceCents !== 0);
  const paid = r.claims.reduce((s, c) => s + c.paidCents, 0);
  const plb = r.providerAdjustments.reduce((s, p) => s + p.amountCents, 0);
  const remittanceDifferenceCents = paid - plb - r.payment.amountCents;
  return {
    balanced: claims.length === 0 && remittanceDifferenceCents === 0,
    claims,
    remittanceDifferenceCents,
  };
}
