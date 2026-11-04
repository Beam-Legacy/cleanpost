import { describe, expect, it } from 'vitest';
import { state } from '../src';

describe('work item state machine', () => {
  it('follows docs/03-state-machines.md', () => {
    expect(state.nextWorkItemState('open', 'assign')).toEqual({ ok: true, value: 'assigned' });
    expect(state.nextWorkItemState('assigned', 'start')).toEqual({ ok: true, value: 'in_progress' });
    expect(state.nextWorkItemState('in_progress', 'resolve')).toEqual({ ok: true, value: 'resolved' });
    expect(state.nextWorkItemState('snoozed', 'wake')).toEqual({ ok: true, value: 'open' });
    expect(state.nextWorkItemState('resolved', 'reopen')).toEqual({ ok: true, value: 'open' });
    // Back to the queue, from W-05 or when the assignee is deactivated (S-03).
    expect(state.nextWorkItemState('assigned', 'unassign')).toEqual({ ok: true, value: 'open' });
    expect(state.nextWorkItemState('in_progress', 'unassign')).toEqual({ ok: true, value: 'open' });
  });

  it('lets automation resolve from any open state but not resolve twice', () => {
    for (const s of ['open', 'assigned', 'in_progress', 'snoozed'] as const) {
      expect(state.nextWorkItemState(s, 'auto_resolve')).toEqual({ ok: true, value: 'resolved' });
    }
    expect(state.nextWorkItemState('resolved', 'auto_resolve').ok).toBe(false);
    expect(state.nextWorkItemState('in_progress', 'snooze').ok).toBe(false);
  });
});

describe('write-off request (D-03)', () => {
  it('is decided once: approved, declined or cancelled', () => {
    expect(state.nextWriteOffRequestState('pending', 'approve')).toEqual({ ok: true, value: 'approved' });
    expect(state.nextWriteOffRequestState('pending', 'decline')).toEqual({ ok: true, value: 'declined' });
    expect(state.nextWriteOffRequestState('pending', 'cancel')).toEqual({ ok: true, value: 'cancelled' });
    for (const from of ['approved', 'declined', 'cancelled'] as const)
      for (const ev of ['approve', 'decline', 'cancel'] as const)
        expect(state.nextWriteOffRequestState(from, ev).ok).toBe(false);
  });
});
