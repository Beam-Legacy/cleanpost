import { describe, expect, it } from 'vitest';
import { state } from '../src';

describe('invitation and membership states', () => {
  it('accepts, revokes or resends a pending invite, and nothing after', () => {
    expect(state.nextInvitationState('pending', 'accept')).toEqual({ ok: true, value: 'accepted' });
    expect(state.nextInvitationState('pending', 'revoke')).toEqual({ ok: true, value: 'revoked' });
    expect(state.nextInvitationState('pending', 'resend')).toEqual({ ok: true, value: 'pending' });
    for (const from of ['accepted', 'revoked'] as const)
      for (const ev of ['accept', 'revoke', 'resend'] as const)
        expect(state.nextInvitationState(from, ev).ok).toBe(false);
  });

  it('treats an invite as expired from its expiry time on', () => {
    const at = new Date('2026-11-11T12:00:00Z');
    expect(state.invitationExpired(at, new Date('2026-11-11T11:59:59Z'))).toBe(false);
    expect(state.invitationExpired(at, at)).toBe(true);
  });

  it('deactivates an active member and reactivates a deactivated one', () => {
    expect(state.nextMembershipState('active', 'deactivate')).toEqual({ ok: true, value: 'deactivated' });
    expect(state.nextMembershipState('deactivated', 'reactivate')).toEqual({ ok: true, value: 'active' });
    expect(state.nextMembershipState('active', 'reactivate').ok).toBe(false);
    expect(state.nextMembershipState('deactivated', 'deactivate').ok).toBe(false);
  });
});
