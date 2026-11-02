/**
 * Write-off approval request (D-03, docs/03-state-machines.md): a biller asks to write off more than
 * the tenant's approval limit; an admin decides.
 * pending -approve-> approved; pending -decline-> declined; pending -cancel-> cancelled (the denial
 * was answered another way first: corrected, paid or written off).
 */
import { transition, type TransitionTable } from './machine';

export type WriteOffRequestState = 'pending' | 'approved' | 'declined' | 'cancelled';
export type WriteOffRequestEvent = 'approve' | 'decline' | 'cancel';

const TABLE: TransitionTable<WriteOffRequestState, WriteOffRequestEvent> = {
  pending: { approve: 'approved', decline: 'declined', cancel: 'cancelled' },
};

export const nextWriteOffRequestState = (from: WriteOffRequestState, event: WriteOffRequestEvent) =>
  transition(TABLE, from, event);
