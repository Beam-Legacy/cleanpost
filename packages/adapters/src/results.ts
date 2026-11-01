import type { AdapterErrorCode, ManualTaskSpec, OpResult, Operation } from './contract';

/** An operation this adapter cannot do automatically: the platform turns it into a manual task. */
export function manualTask(operation: Operation, title: string, instructions: string[]): OpResult {
  return {
    ok: false,
    retryable: false,
    code: 'UNSUPPORTED',
    message: 'Not available through this integration; a manual task was prepared',
    manualTask: { operation, title, instructions } satisfies ManualTaskSpec,
  };
}

/** Typed adapter error. Messages are fixed strings chosen by the adapter, never PM payloads (no PHI). */
export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export const failed = (code: AdapterErrorCode, retryable: boolean, message: string): OpResult => ({
  ok: false,
  retryable,
  code,
  message,
});
