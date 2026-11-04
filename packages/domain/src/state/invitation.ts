/**
 * Invitation (S-02, A-06, docs/03-state-machines.md): an admin invites a person; they accept once.
 * pending -accept-> accepted; pending -revoke-> revoked; pending -resend-> pending (a new token and
 * 7 more days). Expired is not a state: a pending invite past expires_at cannot be accepted, only
 * resent or revoked.
 */
import { transition, type TransitionTable } from './machine';

export type InvitationState = 'pending' | 'accepted' | 'revoked';
export type InvitationEvent = 'accept' | 'revoke' | 'resend';

const TABLE: TransitionTable<InvitationState, InvitationEvent> = {
  pending: { accept: 'accepted', revoke: 'revoked', resend: 'pending' },
};

export const nextInvitationState = (from: InvitationState, event: InvitationEvent) =>
  transition(TABLE, from, event);

export const INVITE_DAYS = 7;

export const invitationExpired = (expiresAt: Date, now: Date) => now.getTime() >= expiresAt.getTime();

/**
 * Membership (S-03): active members can be deactivated (access ends at once) and reactivated; an
 * invited membership is not used (invites live in their own table).
 */
export type MembershipState = 'active' | 'deactivated';
export type MembershipEvent = 'deactivate' | 'reactivate';

const MEMBERSHIP: TransitionTable<MembershipState, MembershipEvent> = {
  active: { deactivate: 'deactivated' },
  deactivated: { reactivate: 'active' },
};

export const nextMembershipState = (from: MembershipState, event: MembershipEvent) =>
  transition(MEMBERSHIP, from, event);
