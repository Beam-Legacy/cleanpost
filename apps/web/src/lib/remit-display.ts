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
