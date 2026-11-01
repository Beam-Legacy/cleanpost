/**
 * Tebra adapter skeleton. Types and mapping exist; live calls are built in M6 against a test
 * practice. Until then every operation is a manual task with Tebra's own screens, and
 * TEBRA_PROFILE records what the built adapter is expected to do (docs/05-adapters.md).
 */
import type { Operation, PmAdapter } from '../contract';
import { manualTask } from '../results';
import { createStubAdapter } from '../stub';

const TEBRA_STEPS: Partial<Record<Operation, { title: string; steps: string[] }>> = {
  releaseCharge: {
    title: 'Approve the encounter in Tebra',
    steps: [
      'In Tebra: Encounters › Find Encounter.',
      'Open the encounter and check the charges match the claim in Cleanpost.',
      'Set the status to Approved and save.',
      'Confirm here.',
    ],
  },
  pushChargeCorrection: {
    title: 'Correct the encounter in Tebra',
    steps: [
      'In Tebra: Encounters › Find Encounter › Edit Encounter.',
      'Make each change in the worksheet.',
      'Leave the encounter in Review; Cleanpost re-checks it and approves it.',
    ],
  },
  postPayment: {
    title: 'Post the payment in Tebra',
    steps: [
      'In Tebra: Encounters › Payments › Enter Payment.',
      'Apply each line from the worksheet with the Tebra adjustment code shown.',
      'Enter the Tebra payment ID here.',
    ],
  },
};

export function createTebraAdapter(): PmAdapter {
  const base = createStubAdapter({ key: 'tebra', pmName: 'Tebra' });
  const task = (op: Operation) => async () => {
    const t = TEBRA_STEPS[op]!;
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
