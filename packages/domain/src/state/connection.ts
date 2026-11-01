/**
 * Connection lifecycle (docs/03-state-machines.md):
 * setup -> testing -> healthy <-> degraded -> failed -> (fix) testing; paused by an admin.
 * degraded: one operation failing, or the last success older than 2x the schedule.
 * failed: authentication failure, or 3 consecutive failed runs.
 */
import { transition, type TransitionTable } from './machine';

export type ConnectionState = 'setup' | 'testing' | 'healthy' | 'degraded' | 'failed' | 'paused';
export type ConnectionEvent =
  | 'test_started'
  | 'sync_succeeded'
  | 'operation_failed'
  | 'stale'
  | 'auth_failed'
  | 'repeated_failures'
  | 'reconnected'
  | 'paused'
  | 'resumed';

const TABLE: TransitionTable<ConnectionState, ConnectionEvent> = {
  setup: {
    test_started: 'testing',
    sync_succeeded: 'healthy',
    operation_failed: 'degraded',
    auth_failed: 'failed',
    paused: 'paused',
  },
  testing: {
    sync_succeeded: 'healthy',
    operation_failed: 'degraded',
    auth_failed: 'failed',
    repeated_failures: 'failed',
    paused: 'paused',
  },
  healthy: {
    sync_succeeded: 'healthy',
    operation_failed: 'degraded',
    stale: 'degraded',
    auth_failed: 'failed',
    repeated_failures: 'failed',
    paused: 'paused',
  },
  degraded: {
    sync_succeeded: 'healthy',
    operation_failed: 'degraded',
    stale: 'degraded',
    auth_failed: 'failed',
    repeated_failures: 'failed',
    paused: 'paused',
  },
  failed: {
    reconnected: 'testing',
    test_started: 'testing',
    sync_succeeded: 'healthy',
    auth_failed: 'failed',
    repeated_failures: 'failed',
    paused: 'paused',
  },
  paused: { resumed: 'testing' },
};

export const nextConnectionState = (from: ConnectionState, event: ConnectionEvent) =>
  transition(TABLE, from, event);

/** States in which scheduled syncs run. */
export const syncsRun = (s: ConnectionState) => s !== 'paused' && s !== 'failed';

export const CONSECUTIVE_FAILURES_TO_FAIL = 3;

/**
 * Decides the event after a sync cycle: every operation's outcome plus how many cycles in a row
 * have failed completely. Pure.
 */
export function connectionEventAfterSync(input: {
  outcomes: { ok: boolean; authFailed?: boolean }[];
  consecutiveFailedCycles: number;
}): ConnectionEvent {
  if (input.outcomes.some((o) => o.authFailed)) return 'auth_failed';
  const failed = input.outcomes.filter((o) => !o.ok).length;
  if (failed === 0) return 'sync_succeeded';
  if (failed === input.outcomes.length && input.consecutiveFailedCycles + 1 >= CONSECUTIVE_FAILURES_TO_FAIL) {
    return 'repeated_failures';
  }
  return 'operation_failed';
}
