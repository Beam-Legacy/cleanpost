/**
 * The 277CA front-end edits (docs/12-testing.md "Payer simulator"): reject structural errors the
 * payer's clearinghouse would catch before adjudication; accept everything else. Inactive coverage
 * is not a front-end rejection: it is accepted here and denied at adjudication (CO-27, M3).
 */
import { z } from 'zod';
import { isValidNpi } from '@cleanpost/domain';

export const submittedClaimSchema = z.object({
  patientControlNumber: z.string().min(1).max(38),
  payerName: z.string().min(1).max(100),
  /** The payer's ID (Stedi trading partner ID); the name is matched when absent. */
  payerId: z.string().max(20).nullish(),
  /** Subscriber member ID, for the payer's member file and accumulators. */
  memberId: z.string().max(80).nullish(),
  priorAuthNumber: z.string().max(50).nullish(),
  /** CLM05-3: 1 original, 7 replacement, 8 void. */
  frequencyCode: z.enum(['1', '7', '8']).nullish(),
  /** The billing provider's organization name, for the 835 payee. */
  billingName: z.string().max(60).nullish(),
  dateOfService: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  renderingNpi: z.string().nullable(),
  billingNpi: z.string().nullable(),
  /** The payer's enrollment view of the member on the date of service. */
  member: z.object({ status: z.enum(['active', 'inactive', 'not_found']) }),
  diagnoses: z.array(z.object({ sequence: z.number().int(), icd10: z.string() })).max(12),
  lines: z
    .array(
      z.object({
        lineNumber: z.number().int(),
        /** REF*6R: echoed on the 835 line when sent. */
        lineControlNumber: z.string().max(50).nullish(),
        code: z.string(),
        modifiers: z.array(z.string()),
        units: z.number().int(),
        chargeCents: z.number().int(),
        pointers: z.array(z.number().int()),
      }),
    )
    .min(1)
    .max(50),
  totalChargeCents: z.number().int(),
});
export type SubmittedClaim = z.infer<typeof submittedClaimSchema>;

export type FrontEndEdit =
  'member_not_found' | 'rendering_npi' | 'billing_npi' | 'no_diagnosis' | 'pointer' | 'total';

/** The edits each payer runs; configurable per payer profile later. */
export const DEFAULT_EDITS: readonly FrontEndEdit[] = [
  'member_not_found',
  'rendering_npi',
  'billing_npi',
  'no_diagnosis',
  'pointer',
  'total',
];

const EDIT: Record<FrontEndEdit, { code: string; reason: string; fails: (c: SubmittedClaim) => boolean }> = {
  member_not_found: {
    code: 'A7:33',
    reason: 'Subscriber not found',
    fails: (c) => c.member.status === 'not_found',
  },
  rendering_npi: {
    code: 'A7:562',
    reason: 'Rendering provider NPI is invalid',
    fails: (c) => c.renderingNpi !== null && !isValidNpi(c.renderingNpi),
  },
  billing_npi: {
    code: 'A7:85',
    reason: 'Billing provider NPI is missing or invalid',
    fails: (c) => !c.billingNpi || !isValidNpi(c.billingNpi),
  },
  no_diagnosis: {
    code: 'A7:254',
    reason: 'Principal diagnosis is missing',
    fails: (c) => c.diagnoses.length === 0,
  },
  pointer: {
    code: 'A7:255',
    reason: 'A diagnosis pointer does not point to a diagnosis',
    fails: (c) =>
      c.lines.some((l) => l.pointers.length === 0 || l.pointers.some((p) => p < 1 || p > c.diagnoses.length)),
  },
  total: {
    code: 'A7:178',
    reason: 'Claim total does not equal the sum of the lines',
    fails: (c) => c.lines.reduce((s, l) => s + l.chargeCents, 0) !== c.totalChargeCents,
  },
};

export interface Ack {
  status: 'accepted' | 'rejected';
  codes: string[];
  reasons: string[];
}

export function acknowledge(claim: SubmittedClaim, edits: readonly FrontEndEdit[] = DEFAULT_EDITS): Ack {
  const failed = edits.filter((e) => EDIT[e].fails(claim));
  if (!failed.length) return { status: 'accepted', codes: ['A2:20'], reasons: [] };
  return {
    status: 'rejected',
    codes: failed.map((e) => EDIT[e].code),
    reasons: failed.map((e) => EDIT[e].reason),
  };
}

/** 1 to 30 minutes, stable for the same claim (so tests and replays agree). */
export function ackDelayMinutes(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return 1 + ((h >>> 0) % 30);
}
