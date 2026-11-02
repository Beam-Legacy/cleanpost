/**
 * Claim lifecycle (docs/03-state-machines.md):
 *
 *   draft -build-> built -scrub-> needs_review -approve-> ready (-unapprove-> needs_review: Undo)
 *                        |        |  `-edit-> built          (new scrub)
 *                        |        `-block-> blocked -fix-> built
 *                        `-scrub(auto)-> ready
 *   built|needs_review|blocked|ready -hold-> on_hold -unhold-> built (re-scrubbed)
 *   ready -release-> submitted
 *   built|needs_review|blocked|on_hold|ready -billed_outside-> submitted  (Mode A: the PM sent it
 *     without Cleanpost's release, e.g. a PM with no hold billing at its batch time)
 *   submitted -999/277CA reject-> rejected -fix-> built        (new version, frequency 1)
 *   submitted -277CA accept-> accepted (-277 status-> accepted)
 *   accepted -835 paid-> paid -close-> closed
 *   accepted -835 partial-> partially_paid -> closed | corrected
 *   accepted -835 denied-> denied -correct-> corrected -release-> submitted; denied -write_off-> closed
 *   any open state -void-> voided
 *   paid/closed -835 reversal-> reversed -> accepted
 *
 * `ready -> submitted` also needs an auto-release decision at or above threshold, or a human
 * approval: `canRelease` checks that; the table only says the move exists.
 */
import { transition, type Result, type TransitionTable } from './machine';

export type ClaimState =
  | 'draft'
  | 'built'
  | 'needs_review'
  | 'blocked'
  | 'on_hold'
  | 'ready'
  | 'submitted'
  | 'rejected'
  | 'accepted'
  | 'paid'
  | 'partially_paid'
  | 'denied'
  | 'corrected'
  | 'closed'
  | 'voided'
  | 'reversed';

export type ClaimEvent =
  | 'build'
  | 'scrub_auto'
  | 'scrub_review'
  | 'scrub_block'
  | 'approve'
  /** Undo of a person's approval within 10 seconds, before the release went out (docs/09). */
  | 'unapprove'
  /** C-12: stop a claim from releasing until something it needs arrives; unhold re-scrubs it. */
  | 'hold'
  | 'unhold'
  | 'edit'
  | 'block'
  | 'fix'
  | 'release'
  /** Mode A: the PM shows the claim sent although Cleanpost had not released it. */
  | 'billed_outside'
  | 'reject'
  | 'accept'
  | 'status'
  | 'pay'
  | 'pay_partial'
  | 'deny'
  | 'correct'
  | 'write_off'
  | 'close'
  | 'void'
  | 'reverse'
  | 'readjudicate';

const editable = {
  edit: 'built',
  void: 'voided',
  hold: 'on_hold',
  billed_outside: 'submitted',
} as const;

const TABLE: TransitionTable<ClaimState, ClaimEvent> = {
  draft: { build: 'built', void: 'voided' },
  built: { scrub_auto: 'ready', scrub_review: 'needs_review', scrub_block: 'blocked', ...editable },
  needs_review: { approve: 'ready', block: 'blocked', ...editable },
  blocked: { fix: 'built', ...editable },
  ready: { release: 'submitted', unapprove: 'needs_review', ...editable },
  // A held claim keeps its hold through new versions (a PM change, a person's edit).
  on_hold: { unhold: 'built', edit: 'on_hold', void: 'voided', billed_outside: 'submitted' },
  submitted: { reject: 'rejected', accept: 'accepted', status: 'submitted', void: 'voided' },
  rejected: { fix: 'built', void: 'voided' },
  accepted: {
    status: 'accepted',
    pay: 'paid',
    pay_partial: 'partially_paid',
    deny: 'denied',
    void: 'voided',
  },
  paid: { close: 'closed', reverse: 'reversed', void: 'voided' },
  partially_paid: { close: 'closed', correct: 'corrected', void: 'voided' },
  denied: { correct: 'corrected', write_off: 'closed', void: 'voided' },
  corrected: { release: 'submitted', ...editable },
  closed: { reverse: 'reversed' },
  reversed: { readjudicate: 'accepted' },
};

export const nextClaimState = (from: ClaimState, event: ClaimEvent) => transition(TABLE, from, event);

/** States where Cleanpost may still change the claim before it leaves (no released version). */
export const isPreRelease = (s: ClaimState) =>
  s === 'draft' ||
  s === 'built' ||
  s === 'needs_review' ||
  s === 'blocked' ||
  s === 'on_hold' ||
  s === 'ready' ||
  s === 'corrected';

export type ScrubDecision = 'auto_release' | 'review' | 'blocked';

/** The scrub decision as a claim event. */
export const scrubEvent = (d: ScrubDecision): ClaimEvent =>
  d === 'auto_release' ? 'scrub_auto' : d === 'review' ? 'scrub_review' : 'scrub_block';

/**
 * ready -> submitted needs either an auto-release scrub at or above the effective threshold, or a
 * human approval of the current version (docs/03-state-machines.md).
 */
export function canRelease(input: {
  state: ClaimState;
  decision: ScrubDecision | null;
  confidence: number | null;
  threshold: number;
  approvedBy: string | null;
}): Result<true, 'not_ready' | 'needs_approval'> {
  if (input.state !== 'ready' && input.state !== 'corrected') return { ok: false, error: 'not_ready' };
  if (input.approvedBy?.startsWith('user:')) return { ok: true, value: true };
  if (input.decision === 'auto_release' && (input.confidence ?? 0) >= input.threshold) {
    return { ok: true, value: true };
  }
  return { ok: false, error: 'needs_approval' };
}
