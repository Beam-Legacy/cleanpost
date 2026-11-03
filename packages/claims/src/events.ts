/**
 * Every claim status change goes through the claim state machine (CLAUDE.md rule 6) and writes a
 * claim_events row with its actor (docs/03-state-machines.md). An invalid transition is a bug in
 * the caller, so it throws.
 */
import { eq } from 'drizzle-orm';
import { claimEvents, claims, type AuditActor, type Tx } from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import { now as clockNow } from '@cleanpost/clock';

export type ClaimRow = typeof claims.$inferSelect;

export class ClaimTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(from: string, event: string) {
    super(`A claim in ${from} cannot take ${event}`);
    this.name = 'ClaimTransitionError';
  }
}

/** claim_events.type for each machine event (docs/02-data-model.md). */
const EVENT_TYPE: Record<state.ClaimEvent, string> = {
  build: 'built',
  edit: 'built',
  fix: 'built',
  scrub_auto: 'scrubbed',
  scrub_review: 'scrubbed',
  scrub_block: 'scrubbed',
  block: 'scrubbed',
  approve: 'approved',
  unapprove: 'unapproved',
  hold: 'held',
  unhold: 'hold_released',
  release: 'released',
  billed_outside: 'released',
  reject: 'rejected',
  accept: 'ack_277ca',
  status: 'status_277',
  pay: 'paid',
  pay_partial: 'partially_paid',
  deny: 'denied',
  correct: 'corrected',
  write_off: 'closed',
  close: 'closed',
  void: 'voided',
  reverse: 'reversed',
  readjudicate: 'status_277',
};

export async function applyClaimEvent(
  tx: Tx,
  claim: Pick<ClaimRow, 'id' | 'tenantId' | 'clientId' | 'status'>,
  event: state.ClaimEvent,
  opts: { actor: AuditActor; versionId?: string | null; payload?: Record<string, unknown>; now?: Date },
): Promise<state.ClaimState> {
  const from = claim.status as state.ClaimState;
  const next = state.nextClaimState(from, event);
  if (!next.ok) throw new ClaimTransitionError(from, event);
  const now = opts.now ?? clockNow();
  if (next.value !== from) {
    await tx.update(claims).set({ status: next.value, updatedAt: now }).where(eq(claims.id, claim.id));
  }
  await tx.insert(claimEvents).values({
    tenantId: claim.tenantId,
    clientId: claim.clientId,
    claimId: claim.id,
    claimVersionId: opts.versionId ?? null,
    type: EVENT_TYPE[event],
    payload: { event, from, to: next.value, ...opts.payload },
    actor: opts.actor,
    occurredAt: now,
  });
  return next.value;
}

/** A claim event that is not a status change (e.g. a correction sent to the PM). */
export async function recordClaimEvent(
  tx: Tx,
  claim: Pick<ClaimRow, 'id' | 'tenantId' | 'clientId'>,
  type: string,
  opts: { actor: AuditActor; versionId?: string | null; payload?: Record<string, unknown>; now?: Date },
): Promise<void> {
  await tx.insert(claimEvents).values({
    tenantId: claim.tenantId,
    clientId: claim.clientId,
    claimId: claim.id,
    claimVersionId: opts.versionId ?? null,
    type,
    payload: opts.payload ?? {},
    actor: opts.actor,
    occurredAt: opts.now ?? clockNow(),
  });
}
