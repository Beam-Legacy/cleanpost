/**
 * Words for remittances (R-01, R-04): states, line results and short plain meanings of the
 * adjustment reason codes (CARCs, from the public X12 code list; procedure descriptions are never
 * shown, CLAUDE.md rule 11).
 */
import type { Status } from '@cleanpost/ui';

export const REMIT_STATUS: Record<string, Status> = {
  received: 'Waiting for PM',
  parsed: 'Waiting for PM',
  balanced: 'Waiting for PM',
  matched: 'Waiting for PM',
  verifying: 'Waiting for PM',
  partially_matched: 'Unmatched',
  out_of_balance: 'Out of balance',
  posting_mismatch: 'Differences',
  reconciled: 'Verified',
  posting: 'Running',
  posted: 'Posted',
  post_failed: 'Failed',
};

/** A line's result against the PM posting (remit_lines.verify_status and its differences). */
export function lineResult(status: string | null, fields: string[]): Status {
  if (status === 'verified') return 'Matches';
  // Posted by hand from a worksheet and confirmed by a person (manual posting, M-01).
  if (status === 'confirmed') return 'Posted';
  if (status === 'missing') return 'Missing posting';
  if (status === 'unmapped') return 'Needs mapping';
  if (status === 'mismatch')
    return fields.includes('Denial written off') ? 'Denial written off' : 'Does not match';
  return 'Waiting for PM';
}

export const CARC_LABEL: Record<string, string> = {
  '1': 'deductible',
  '2': 'coinsurance',
  '3': 'copay',
  '4': 'modifier missing or wrong; balance stays open',
  '18': 'duplicate claim; balance stays open',
  '23': 'paid by a prior payer',
  '27': 'coverage not active; balance stays open',
  '29': 'filed after the deadline; balance stays open',
  '31': 'not this payer’s member; balance stays open',
  '45': 'above the contracted rate, written off',
  '97': 'included in another service; balance stays open',
  '197': 'no prior authorization; balance stays open',
  '253': 'sequestration, written off',
};

export const PLB_LABEL: Record<string, string> = {
  L6: 'interest',
  WO: 'overpayment recovery',
  FB: 'forwarding balance',
  CS: 'adjustment',
};

/** What the group code says about who owes the amount (R-08). */
export const GROUP_LABEL: Record<string, string> = {
  CO: 'Contractual: the provider cannot bill the patient for this',
  PR: 'Patient responsibility: the patient (or a secondary payer) may be billed',
  OA: 'Other adjustment',
  PI: 'Payer initiated reduction',
  CR: 'Correction or reversal',
};

/** Remark codes the payer simulator and common 835s use, in our own words (R-08). */
export const RARC_LABEL: Record<string, string> = {
  N822: 'A required modifier is missing',
  M15: 'Billed separately but paid as part of another service',
  N30: 'The patient was not eligible for this service',
  MA01: 'The claim may be appealed',
  N522: 'Duplicate of a claim processed before',
};

/** One code's plain meaning: "CO-45", "PR-1", a RARC like "N822", or a bare CARC. */
export function explainCode(code: string): { title: string; lines: string[] } {
  const pair = /^(CO|PR|OA|PI|CR)-([A-Z0-9]+)$/.exec(code);
  if (pair) {
    const [, group, carc] = pair as unknown as [string, string, string];
    return {
      title: code,
      lines: [
        CARC_LABEL[carc] ? capitalize(CARC_LABEL[carc]) : 'No description on file',
        GROUP_LABEL[group] ?? '',
      ].filter(Boolean),
    };
  }
  if (RARC_LABEL[code]) return { title: code, lines: [RARC_LABEL[code]] };
  if (CARC_LABEL[code]) return { title: code, lines: [capitalize(CARC_LABEL[code])] };
  return { title: code, lines: ['No description on file'] };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
