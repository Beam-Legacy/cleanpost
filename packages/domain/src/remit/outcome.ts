/**
 * What one claim payment means for the claim (docs/03 claim machine, docs/07): paid, partly paid,
 * denied or reversed; how much stays open; and which lines were denied, by category, for the
 * denial queue (docs/08 priorities: auth/eligibility 1, coding 2, other 3).
 */
import type { Adjustment, ClaimPayment } from './types';

/** CARCs that are contractual reductions, not denials (the provider cannot bill them). */
const CONTRACTUAL = new Set(['45', '253', '59', '94', '131', '144', '237']);
const AUTH_ELIGIBILITY = new Set(['197', '198', '15', '27', '26', '31', '109', '200', '242', '243']);
const CODING = new Set([
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '11',
  '16',
  '125',
  '146',
  '150',
  '181',
  '182',
  '234',
  '236',
]);

export type DenialCategory = 'auth_eligibility' | 'coding' | 'other';

export interface PaymentOutcome {
  event: 'pay' | 'pay_partial' | 'deny' | 'reverse';
  /** What is still owed after this payment: patient responsibility plus anything denied. */
  balanceCents: number;
  denials: {
    carc: string;
    group: string;
    amountCents: number;
    category: DenialCategory;
    lineIndex: number | null;
  }[];
}

/** A denial: a CO or PI reduction that is not contractual. */
export const isDenialAdjustment = (a: Adjustment) =>
  a.amountCents > 0 && (a.group === 'CO' || a.group === 'PI') && !CONTRACTUAL.has(a.carc);
const isDenial = isDenialAdjustment;

/**
 * S-08 / W-19: a group code and CARC that mean a denial (CO or PI, not contractual). These never get
 * an adjustment mapping: the balance stays open for the denial queue, and a mapping would make
 * verification expect the PM to adjust it off (docs/07).
 */
export const isDenialCode = (group: string, carc: string) =>
  (group === 'CO' || group === 'PI') && !CONTRACTUAL.has(carc);

export function denialCategory(carc: string): DenialCategory {
  if (AUTH_ELIGIBILITY.has(carc)) return 'auth_eligibility';
  if (CODING.has(carc)) return 'coding';
  return 'other';
}

export const DENIAL_PRIORITY: Record<DenialCategory, 1 | 2 | 3> = {
  auth_eligibility: 1,
  coding: 2,
  other: 3,
};

export function paymentOutcome(c: ClaimPayment): PaymentOutcome {
  const denials: PaymentOutcome['denials'] = [];
  c.adjustments.filter(isDenial).forEach((a) =>
    denials.push({
      carc: a.carc,
      group: a.group,
      amountCents: a.amountCents,
      category: denialCategory(a.carc),
      lineIndex: null,
    }),
  );
  c.lines.forEach((l, i) =>
    l.adjustments.filter(isDenial).forEach((a) =>
      denials.push({
        carc: a.carc,
        group: a.group,
        amountCents: a.amountCents,
        category: denialCategory(a.carc),
        lineIndex: i,
      }),
    ),
  );
  const denied = denials.reduce((s, d) => s + d.amountCents, 0);
  const balanceCents = Math.max(0, c.patientRespCents + denied);
  if (c.statusCode === '22') return { event: 'reverse', balanceCents: 0, denials: [] };
  if (c.statusCode === '4' || (c.paidCents === 0 && denied > 0))
    return { event: 'deny', balanceCents, denials };
  return { event: denied > 0 ? 'pay_partial' : 'pay', balanceCents, denials };
}
