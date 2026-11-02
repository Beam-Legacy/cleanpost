/**
 * Claim status (276/277; C-15, W-15, docs/04-modes.md "Daily sweep"): what a payer's answer means
 * in plain words, what to do next, and the task it implies. Deterministic rules: the same answer
 * gives the same advice (CLAUDE.md rule 9). Codes from the X12 claim status category (507) and
 * status (508) lists, explained in our own words.
 */

/** One claim in a 277, normalized from Stedi's JSON (amounts in cents, dates YYYY-MM-DD). */
export interface ClaimStatusResult {
  category: string;
  code: string | null;
  entityCode: string | null;
  effectiveDate: string | null;
  payerClaimNumber: string | null;
  patientAccountNumber: string | null;
  submittedCents: number | null;
  paidCents: number | null;
  paidDate: string | null;
  checkNumber: string | null;
  checkIssueDate: string | null;
}

export type StatusKind =
  | 'not_found'
  | 'rejected'
  | 'received'
  | 'pending'
  | 'needs_info'
  | 'paid'
  | 'denied'
  | 'no_payment'
  | 'error';

export const CATEGORY_LABEL: Record<string, string> = {
  A0: 'Forwarded to another payer',
  A1: 'Received',
  A2: 'Accepted into processing',
  A3: 'Returned as unprocessable',
  A4: 'Not found',
  A5: 'Split into more than one claim',
  A6: 'Rejected: missing information',
  A7: 'Rejected: invalid information',
  A8: 'Rejected: fields that do not agree',
  D0: 'No match found',
  E0: 'No answer: payer system error',
  E1: 'No answer: payer system unavailable',
  E2: 'No answer: the payer did not respond',
  E3: 'No answer: the request needs correcting',
  E4: 'No answer: not set up with this payer',
  F0: 'Finalized',
  F1: 'Finalized: paid',
  F2: 'Finalized: denied',
  F3: 'Finalized: revised',
  F3F: 'Finalized: forwarded',
  F3N: 'Finalized: not forwarded',
  F4: 'Finalized: no payment coming',
  P0: 'Pending: being adjudicated',
  P1: 'Pending, in process',
  P2: 'Pending: payer review',
  P3: 'Pending: waiting for information from the provider',
  P4: 'Pending: waiting for information from the patient',
  P5: 'Pending: payer hold',
};

export const STATUS_CODE_LABEL: Record<string, string> = {
  '0': 'No further status available electronically',
  '1': 'See the remittance advice for details',
  '3': 'Decided, waiting for the payment cycle',
  '19': 'Receipt acknowledged',
  '20': 'Accepted for processing',
  '21': 'Missing or invalid information',
  '35': 'Claim not found',
  '65': 'Paid',
  '88': 'Patient not eligible',
  '107': 'Processed under the plan’s terms',
};

export const categoryLabel = (c: string) =>
  CATEGORY_LABEL[c] ?? (c.startsWith('R') ? 'Payer asks for more information' : `Category ${c}`);
export const statusCodeLabel = (c: string | null) =>
  c === null ? null : (STATUS_CODE_LABEL[c] ?? `Status ${c} (see the payer’s portal)`);

export function statusKind(category: string): StatusKind {
  if (category === 'A4' || category === 'D0') return 'not_found';
  if (['A3', 'A6', 'A7', 'A8'].includes(category)) return 'rejected';
  if (category.startsWith('A')) return 'received';
  if (category === 'P3' || category === 'P4' || category.startsWith('R')) return 'needs_info';
  if (category.startsWith('P')) return 'pending';
  if (category === 'F1') return 'paid';
  if (category === 'F2') return 'denied';
  if (category.startsWith('F')) return 'no_payment';
  return 'error';
}

/** The payer has the claim in its system (a 277CA acceptance may not have come through). */
export const payerHasClaim = (k: StatusKind) =>
  ['received', 'pending', 'needs_info', 'paid', 'denied', 'no_payment'].includes(k);

/** A person checks a claim at most once a day; the sweep checks open follow-ups once a week. */
export const MANUAL_CHECK_HOURS = 24;
export const AUTO_CHECK_DAYS = 7;
/** Follow-up (no_response) when there is no 277CA this long after sending... */
export const NO_ACK_DAYS = 7;
/** ...or no payment this long after the payer accepted the claim. */
export const NO_PAYMENT_DAYS = 30;

export interface StatusTask {
  operation: 'requestRecords' | 'resubmitClaim';
  title: string;
  instructions: string[];
}

export interface StatusAdvice {
  kind: StatusKind;
  /** One line, e.g. "Pended: waiting for medical records." */
  headline: string;
  explanation: string;
  /** What to do next (rules, shown as Suggested). */
  suggestion: string | null;
  /** The task the answer implies, if any (C-15 "Create task"). */
  task: StatusTask | null;
}

const money = (cents: number | null) =>
  cents === null ? '' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const when = (ymd: string | null) =>
  ymd
    ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : 'a recent date';

export function adviseStatus(
  r: ClaimStatusResult,
  ctx: {
    payerName: string;
    pmName: string;
    /** The 835 with this payment or denial is in Cleanpost. */
    paymentArrived: boolean;
    patientControlNumber: string | null;
  },
): StatusAdvice {
  const kind = statusKind(r.category);
  const payer = ctx.payerName;
  const pcn = ctx.patientControlNumber ? ` (control number ${ctx.patientControlNumber})` : '';
  const ref = r.payerClaimNumber ? `, payer claim number ${r.payerClaimNumber}` : '';
  const resubmit: StatusTask = {
    operation: 'resubmitClaim',
    title: `Resubmit the claim to ${payer} from ${ctx.pmName}`,
    instructions: [
      `In ${ctx.pmName}, open the claim${pcn} and check it was sent to ${payer}.`,
      `Correct anything ${payer} named, then resubmit it as an original claim.`,
      'Mark this task done once it is sent; the next status check confirms it arrived.',
    ],
  };
  switch (kind) {
    case 'not_found':
      return {
        kind,
        headline: `${payer} has no record of this claim.`,
        explanation: `${payer} could not find a claim for this patient and date of service. It may not have been sent, or it was rejected before reaching ${payer}.`,
        suggestion: `Check in ${ctx.pmName} that it was sent; if it was sent more than a week ago, resubmit it.`,
        task: resubmit,
      };
    case 'rejected':
      return {
        kind,
        headline: `${payer} returned the claim without processing it.`,
        explanation: `${categoryLabel(r.category)}${r.code ? `: ${statusCodeLabel(r.code)?.toLowerCase()}` : ''}. Nothing will be paid on it as sent.`,
        suggestion: `Correct the claim in ${ctx.pmName} and resubmit it.`,
        task: resubmit,
      };
    case 'received':
      return {
        kind,
        headline: `${payer} has the claim.`,
        explanation: `${categoryLabel(r.category)} on ${when(r.effectiveDate)}${ref}.`,
        suggestion: null,
        task: null,
      };
    case 'pending':
      return {
        kind,
        headline: 'Pended: in process.',
        explanation: `${payer} has the claim and is still processing it${ref}.`,
        suggestion: 'Nothing to do yet: Cleanpost checks again in a week.',
        task: null,
      };
    case 'needs_info':
      return {
        kind,
        headline: 'Pended: waiting for medical records.',
        explanation: `${payer} has the claim and needs documentation before deciding${ref}.`,
        suggestion: `Ask the practice for the visit note and send it to ${payer} as a claim attachment.`,
        task: {
          operation: 'requestRecords',
          title: `Send the visit note to ${payer}`,
          instructions: [
            `Ask the practice for the visit note for the claim${pcn}.`,
            `Send it to ${payer} as a claim attachment${r.payerClaimNumber ? `, quoting payer claim number ${r.payerClaimNumber}` : ''}.`,
            'Mark this task done once it is sent; Cleanpost keeps checking the claim.',
          ],
        },
      };
    case 'paid':
      return ctx.paymentArrived
        ? {
            kind,
            headline: `Paid on ${when(r.paidDate)}.`,
            explanation: `${payer} paid ${money(r.paidCents)}; the payment is in Cleanpost.`,
            suggestion: null,
            task: null,
          }
        : {
            kind,
            headline: `Paid on ${when(r.paidDate)}; the payment has not arrived yet.`,
            explanation: `${payer} paid ${money(r.paidCents)}${r.checkNumber ? ` (check or EFT ${r.checkNumber})` : ''}. The 835 for it has not reached Cleanpost.`,
            suggestion: `Wait for the 835; if it is not here a week after ${when(r.checkIssueDate ?? r.paidDate)}, ask ${payer} to send it again.`,
            task: null,
          };
    case 'denied':
      return {
        kind,
        headline: ctx.paymentArrived
          ? `Denied on ${when(r.paidDate)}.`
          : `Denied on ${when(r.paidDate)}; the 835 has not arrived yet.`,
        explanation: ctx.paymentArrived
          ? 'The denial and its reasons are in Cleanpost: work it from Denials.'
          : `${payer} denied the claim. The reasons come with the 835.`,
        suggestion: ctx.paymentArrived ? null : 'Wait for the 835 to see why it was denied.',
        task: null,
      };
    case 'no_payment':
      return {
        kind,
        headline: `${payer} finished the claim with no payment.`,
        explanation: `${categoryLabel(r.category)}${r.code ? `: ${statusCodeLabel(r.code)?.toLowerCase()}` : ''}.`,
        suggestion: 'Look for the 835 or the payer’s explanation before writing anything off.',
        task: null,
      };
    default:
      return {
        kind,
        headline: `${payer} could not answer.`,
        explanation: `${categoryLabel(r.category)}.`,
        suggestion: 'Cleanpost tries again later.',
        task: null,
      };
  }
}
