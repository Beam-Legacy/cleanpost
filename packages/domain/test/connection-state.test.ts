import { describe, expect, it } from 'vitest';
import { connectionEventAfterSync, nextConnectionState, syncsRun } from '../src/state';

describe('connection state machine', () => {
  it('follows docs/03-state-machines.md', () => {
    expect(nextConnectionState('setup', 'test_started')).toEqual({ ok: true, value: 'testing' });
    expect(nextConnectionState('testing', 'sync_succeeded')).toEqual({ ok: true, value: 'healthy' });
    expect(nextConnectionState('healthy', 'operation_failed')).toEqual({ ok: true, value: 'degraded' });
    expect(nextConnectionState('degraded', 'sync_succeeded')).toEqual({ ok: true, value: 'healthy' });
    expect(nextConnectionState('degraded', 'repeated_failures')).toEqual({ ok: true, value: 'failed' });
    expect(nextConnectionState('failed', 'reconnected')).toEqual({ ok: true, value: 'testing' });
    expect(nextConnectionState('healthy', 'paused')).toEqual({ ok: true, value: 'paused' });
    expect(nextConnectionState('paused', 'resumed')).toEqual({ ok: true, value: 'testing' });
  });

  it('rejects invalid transitions', () => {
    expect(nextConnectionState('paused', 'sync_succeeded')).toEqual({
      ok: false,
      error: 'invalid_transition',
    });
  });

  it('stops scheduled syncs when paused or failed', () => {
    expect(syncsRun('healthy')).toBe(true);
    expect(syncsRun('paused')).toBe(false);
    expect(syncsRun('failed')).toBe(false);
  });

  it('turns sync outcomes into one event', () => {
    expect(
      connectionEventAfterSync({ outcomes: [{ ok: true }, { ok: true }], consecutiveFailedCycles: 0 }),
    ).toBe('sync_succeeded');
    expect(
      connectionEventAfterSync({ outcomes: [{ ok: true }, { ok: false }], consecutiveFailedCycles: 5 }),
    ).toBe('operation_failed');
    expect(connectionEventAfterSync({ outcomes: [{ ok: false }], consecutiveFailedCycles: 1 })).toBe(
      'operation_failed',
    );
    expect(connectionEventAfterSync({ outcomes: [{ ok: false }], consecutiveFailedCycles: 2 })).toBe(
      'repeated_failures',
    );
    expect(
      connectionEventAfterSync({ outcomes: [{ ok: false, authFailed: true }], consecutiveFailedCycles: 0 }),
    ).toBe('auth_failed');
  });
});
