/** Adjustment mapping words, shared by W-19 (map from the queue) and S-08 (settings). */
import { CARC_LABEL, GROUP_LABEL } from './remit-display';

export const MAPPING_ACTIONS = [
  { value: 'write_off', label: 'Write off (contractual)' },
  { value: 'transfer_to_patient', label: 'Transfer to patient' },
  { value: 'adjust', label: 'Adjust' },
  { value: 'info_only', label: 'Information only (no posting)' },
] as const;

export type MappingActionValue = (typeof MAPPING_ACTIONS)[number]['value'];

export const mappingActionLabel = (a: string | null) =>
  MAPPING_ACTIONS.find((x) => x.value === a)?.label ?? '—';

/** "Deductible", or the group's meaning when the CARC has no plain words yet. */
export function codeMeaning(group: string, carc: string): string {
  const c = CARC_LABEL[carc];
  if (c) return c.charAt(0).toUpperCase() + c.slice(1);
  return GROUP_LABEL[group]?.split(':')[0] ?? 'Adjustment';
}
