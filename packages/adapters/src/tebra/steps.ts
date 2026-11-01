/** Tebra's own screens for the steps Cleanpost cannot do through Tebra's API. */
import type { Operation } from '../contract';

export const TEBRA_MANUAL_STEPS: Partial<Record<Operation, { title: string; steps: string[] }>> = {
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
  markChargeBilled: {
    title: 'Nothing to mark in Tebra',
    steps: [
      'Tebra has no way to mark a charge billed outside Tebra.',
      'In Mode A, Tebra sends the claim itself after the encounter is approved; no action is needed.',
    ],
  },
};
