/**
 * Tebra adapter skeleton. Types and mapping exist; live calls are built in M6 against a test
 * practice. Until then every operation is a manual task with Tebra's own screens, and
 * TEBRA_PROFILE records what the built adapter is expected to do (docs/05-adapters.md).
 */
import type { Operation, PmAdapter } from '../contract';
import { manualTask } from '../results';
import { createStubAdapter } from '../stub';
import { TEBRA_MANUAL_STEPS } from './steps';

export function createTebraAdapter(): PmAdapter {
  const base = createStubAdapter({ key: 'tebra', pmName: 'Tebra' });
  const task = (op: Operation) => async () => {
    const t = TEBRA_MANUAL_STEPS[op]!;
    return manualTask(op, t.title, t.steps);
  };
  return {
    ...base,
    syncPolicy: { defaultIntervalMinutes: 120, preferOffHours: true },
    releaseCharge: task('releaseCharge'),
    pushChargeCorrection: task('pushChargeCorrection'),
    postPayment: task('postPayment'),
  };
}

export { mapChargeToClaimStatus, mapChargeToPosting } from './map';
export type * from './types';
export { TEBRA_MANUAL_STEPS } from './steps';
