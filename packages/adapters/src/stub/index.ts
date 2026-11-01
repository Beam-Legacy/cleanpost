/**
 * Stub adapter for a PM that has no integration yet (docs/05-adapters.md): every operation is a
 * manual task, pulls return nothing. Real capabilities come when the adapter is built.
 */
import type { AdapterKey, CapabilityMap, Connection, Operation, PmAdapter } from '../contract';
import { manualTask } from '../results';
import { OPERATIONS } from '../profiles';

export interface StubMeta {
  key: AdapterKey;
  pmName: string;
}

const MANUAL_CAPS: CapabilityMap = Object.fromEntries(
  OPERATIONS.map((o) => [o, o === 'holdCharge' || o === 'releaseCharge' ? 'unavailable' : 0]),
) as CapabilityMap;

/** Instructions shared by stubs; PM-specific adapters replace them with exact screens. */
export function manualInstructions(pmName: string, op: Operation): { title: string; steps: string[] } {
  switch (op) {
    case 'markChargeBilled':
      return {
        title: `Mark the charge billed in ${pmName}`,
        steps: [
          `Open the encounter in ${pmName}.`,
          'Mark the charge as billed outside the PM, with the claim number shown here.',
          'Confirm here when done.',
        ],
      };
    case 'pushChargeCorrection':
      return {
        title: `Correct the charge in ${pmName}`,
        steps: [
          `Open the encounter in ${pmName}.`,
          'Make each change listed in the worksheet.',
          'Save, then confirm here so Cleanpost re-checks the claim.',
        ],
      };
    case 'postPayment':
      return {
        title: `Post the payment in ${pmName}`,
        steps: [
          `Open payment posting in ${pmName}.`,
          'Post each line from the worksheet: paid amount, each adjustment with the PM code shown, and patient responsibility.',
          'Enter the PM payment ID here to confirm.',
        ],
      };
    default:
      return { title: `Complete in ${pmName}`, steps: [`Do this step in ${pmName}, then confirm here.`] };
  }
}

export function createStubAdapter(meta: StubMeta): PmAdapter {
  const empty = async () => ({ items: [], nextCursor: null });
  const task = (op: Operation) => async (_conn: Connection) => {
    const { title, steps } = manualInstructions(meta.pmName, op);
    return manualTask(op, title, steps);
  };
  return {
    key: meta.key,
    syncPolicy: { defaultIntervalMinutes: 0, preferOffHours: false },
    capabilities: async () => MANUAL_CAPS,
    healthCheck: async () => ({ ok: true, checkedAt: new Date(), details: {} }),
    pullPatientsAndCoverage: empty,
    pullCharges: empty,
    pullClaimsAndStatus: empty,
    pullRemittances: empty,
    pullPostings: empty,
    holdCharge: async () =>
      manualTask('holdCharge', 'Hold not available', [
        `${meta.pmName} cannot hold charges; Cleanpost checks them before the PM's batch.`,
      ]),
    releaseCharge: async () =>
      manualTask('releaseCharge', 'Release not available', [
        `${meta.pmName} sends charges on its own schedule.`,
      ]),
    markChargeBilled: task('markChargeBilled'),
    pushChargeCorrection: task('pushChargeCorrection'),
    postPayment: task('postPayment'),
  };
}
