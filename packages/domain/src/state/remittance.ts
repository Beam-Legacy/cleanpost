/**
 * Remittance lifecycle (docs/03-state-machines.md):
 *
 *   received -parse-> parsed -balance-> balanced | out_of_balance
 *   out_of_balance -accept_difference-> balanced (admin, with a reason)
 *   balanced -match-> matched | partially_matched;  partially_matched -resolve_unmatched-> matched
 *   matched -post-> posting -post_ok-> posted -posting_match-> reconciled | posting_mismatch  (Mode B)
 *   posting -post_fail-> post_failed -retry-> posting
 *   matched -verify-> verifying -posting_match-> reconciled | posting_mismatch                 (Modes A, C)
 *   posting_mismatch -resolve_exceptions-> reconciled
 */
import { transition, type TransitionTable } from './machine';

export type RemittanceState =
  | 'received'
  | 'parsed'
  | 'balanced'
  | 'out_of_balance'
  | 'matched'
  | 'partially_matched'
  | 'posting'
  | 'post_failed'
  | 'posted'
  | 'verifying'
  | 'posting_mismatch'
  | 'reconciled';

export type RemittanceEvent =
  | 'parse'
  | 'balance_ok'
  | 'balance_fail'
  | 'accept_difference'
  | 'match_all'
  | 'match_some'
  | 'resolve_unmatched'
  | 'post'
  | 'post_ok'
  | 'post_fail'
  | 'retry'
  | 'verify'
  | 'posting_match'
  | 'posting_mismatch'
  | 'resolve_exceptions';

const TABLE: TransitionTable<RemittanceState, RemittanceEvent> = {
  received: { parse: 'parsed' },
  parsed: { balance_ok: 'balanced', balance_fail: 'out_of_balance' },
  out_of_balance: { accept_difference: 'balanced' },
  balanced: { match_all: 'matched', match_some: 'partially_matched' },
  partially_matched: { resolve_unmatched: 'matched' },
  matched: { post: 'posting', verify: 'verifying' },
  posting: { post_ok: 'posted', post_fail: 'post_failed' },
  post_failed: { retry: 'posting' },
  posted: { posting_match: 'reconciled', posting_mismatch: 'posting_mismatch' },
  verifying: { posting_match: 'reconciled', posting_mismatch: 'posting_mismatch' },
  posting_mismatch: { resolve_exceptions: 'reconciled' },
  reconciled: {},
};

export const nextRemittanceState = (from: RemittanceState, event: RemittanceEvent) =>
  transition(TABLE, from, event);
