/**
 * P-02 coverage and P-06 patient corrections (DEC-30): what a person may enter, which fields
 * changed, and how a PM task describes them without the values (the task links to the record,
 * where the values are shown to people allowed to see them). Pure.
 */
import { z } from 'zod';

export const RELATIONSHIPS = ['self', 'spouse', 'child', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Medicare Beneficiary Identifier: 11 characters, no S, L, O, I, B or Z; dashes allowed. */
const MBI =
  /^[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9-]{1,29}$/;

/** Member ID format by payer where it is known; null when it fits. */
export function memberIdProblem(memberId: string, payerName: string | null): string | null {
  const id = memberId.trim().toUpperCase();
  if (payerName && /^medicare\b/i.test(payerName)) {
    return MBI.test(id) ? null : 'A Medicare ID (MBI) has 11 characters, like 1EG4-TE5-MK73.';
  }
  return MEMBER_ID.test(id) ? null : 'Use 2 to 30 letters, digits or dashes.';
}

const ymd = z.iso.date();

export const coverageEditSchema = z
  .object({
    payerId: z.uuid(),
    /** Blank keeps the member ID the coverage has. */
    memberId: z.string().trim().max(30).optional(),
    groupNumber: z.string().trim().max(30).optional(),
    relationship: z.enum(RELATIONSHIPS),
    priority: z.number().int().min(1).max(3),
    effectiveDate: ymd.optional().or(z.literal('')),
    terminationDate: ymd.optional().or(z.literal('')),
    checkEligibility: z.boolean().default(true),
  })
  .refine((v) => !v.effectiveDate || !v.terminationDate || v.terminationDate >= v.effectiveDate, {
    path: ['terminationDate'],
    message: 'The end date is before the start date.',
  });
export type CoverageEdit = z.infer<typeof coverageEditSchema>;

export const US_STATES = /^[A-Z]{2}$/;

export const patientEditSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name.').max(60),
  lastName: z.string().trim().min(1, 'Enter a last name.').max(60),
  dob: ymd,
  sex: z.enum(['M', 'F', 'U']),
  address: z
    .object({
      line1: z.string().trim().max(80),
      line2: z.string().trim().max(80).optional(),
      city: z.string().trim().max(60),
      state: z
        .string()
        .trim()
        .toUpperCase()
        .regex(US_STATES, 'Use the two-letter state code.')
        .or(z.literal('')),
      zip: z
        .string()
        .trim()
        .regex(/^\d{5}(-?\d{4})?$/, 'Use a 5- or 9-digit ZIP code.')
        .or(z.literal('')),
    })
    .optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s().-]{10,20}$/, 'Use a 10-digit phone number.')
    .or(z.literal(''))
    .optional(),
});
export type PatientEdit = z.infer<typeof patientEditSchema>;

/** A date of birth a person could have: not in the future, not over 120 years ago. */
export function dobProblem(dob: string, today: string): string | null {
  if (dob > today) return 'The date of birth is in the future.';
  const [y] = today.split('-').map(Number) as [number];
  if (dob < `${y - 120}${today.slice(4)}`) return 'The date of birth is over 120 years ago.';
  return null;
}

/** Key-order-independent equality for JSON-like values (null and undefined and '' are the same). */
function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => [k, norm(x)] as const)
        .filter(([, x]) => x !== null)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return v;
}
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** The fields whose values differ, in the order given. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): (keyof T & string)[] {
  return fields.filter((f) => f in after && !sameValue(before[f], after[f]));
}

export const FIELD_LABEL: Record<string, string> = {
  payerId: 'payer',
  memberId: 'member ID',
  groupNumber: 'group number',
  relationship: 'relationship to the subscriber',
  priority: 'order (primary, secondary)',
  effectiveDate: 'start date',
  terminationDate: 'end date',
  firstName: 'first name',
  lastName: 'last name',
  dob: 'date of birth',
  sex: 'sex',
  address: 'address',
  phone: 'phone',
};

/** "member ID and group number", "payer, member ID and end date". */
export function fieldList(fields: readonly string[]): string {
  const words = fields.map((f) => FIELD_LABEL[f] ?? f);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export const UPDATE_COVERAGE = 'updateCoverage';
export const UPDATE_PATIENT = 'updatePatient';
export const CHANGE_VISIT_COVERAGE = 'changeVisitCoverage';
export const MARK_SELF_PAY = 'markSelfPay';

/**
 * PM tasks. Like every work item, their text names no patient (the queue and panel show who it is,
 * from the record): "this patient" in the PM is the one the task's patient link opens.
 */
export function coverageTask(p: { payer: string; fields: readonly string[]; pmName: string }) {
  return {
    operation: UPDATE_COVERAGE,
    title: `Update ${p.payer} coverage in ${p.pmName}`,
    instructions: [
      `In ${p.pmName}, open this patient's ${p.payer} insurance and change the ${fieldList(p.fields)}.`,
      'Open the patient in Cleanpost to see the corrected values (the member ID is revealed on request).',
      `Claims for this patient wait until ${p.pmName} shows the change; this closes itself on the next sync that does.`,
    ],
  };
}

export function patientTask(p: { fields: readonly string[]; pmName: string }) {
  return {
    operation: UPDATE_PATIENT,
    title: `Update patient details in ${p.pmName}`,
    instructions: [
      `In ${p.pmName}, open this patient's demographics and change the ${fieldList(p.fields)}.`,
      'Open the patient in Cleanpost to see the corrected values.',
      `Claims for this patient wait until ${p.pmName} shows the change; this closes itself on the next sync that does.`,
    ],
  };
}

/** The PM still differs after a person closed the task: the sync conflict note (P-06 rule). */
export function conflictTask(p: { what: 'coverage' | 'details'; pmName: string }) {
  return {
    operation: p.what === 'coverage' ? UPDATE_COVERAGE : UPDATE_PATIENT,
    title: `${p.pmName} still shows the old ${p.what === 'coverage' ? 'coverage' : 'patient details'}`,
    instructions: [
      `The last sync from ${p.pmName} does not match the correction made in Cleanpost, although its task was closed.`,
      `Update ${p.pmName} to match, or correct the record in Cleanpost again to match ${p.pmName}.`,
    ],
  };
}
