/**
 * Zod schemas for the external records adapters return (contract.ts). Every pull result is
 * validated here at the boundary (CLAUDE.md: validate every external input) before sync maps it to
 * canonical rows.
 */
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.string().min(10);
const cents = z.number().int();
const sex = z.enum(['M', 'F', 'U']);

export const extCoverageSchema = z.object({
  externalId: z.string().min(1),
  payerName: z.string().min(1),
  payerExternalId: z.string().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  memberId: z.string().min(1),
  groupNumber: z.string().optional(),
  relationship: z.enum(['self', 'spouse', 'child', 'other']),
  subscriber: z.object({ firstName: z.string(), lastName: z.string(), dob: isoDate, sex }).optional(),
  effectiveDate: isoDate.optional(),
  terminationDate: isoDate.optional(),
});

export const extPatientSchema = z.object({
  externalId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dob: isoDate,
  sex,
  address: z
    .object({
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      state: z.string().length(2),
      zip: z.string(),
    })
    .optional(),
  phone: z.string().optional(),
  coverages: z.array(extCoverageSchema),
  updatedAt: isoDateTime,
});

export const extEncounterSchema = z.object({
  externalId: z.string().min(1),
  patientExternalId: z.string().min(1),
  dateOfService: isoDate,
  renderingProviderNpi: z.string().regex(/^\d{10}$/),
  referringProviderNpi: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  locationExternalId: z.string().min(1),
  placeOfService: z.string().regex(/^\d{2}$/),
  priorAuthNumber: z.string().optional(),
  diagnoses: z
    .array(z.object({ sequence: z.number().int().min(1).max(12), icd10: z.string().min(3) }))
    .min(1),
  lines: z
    .array(
      z.object({
        externalId: z.string().min(1),
        code: z.string().min(4),
        modifiers: z.array(z.string().length(2)).max(4),
        units: z.number().int().positive(),
        chargeCents: cents.nonnegative(),
        diagnosisPointers: z.array(z.number().int().min(1).max(12)).min(1).max(4),
        ndc: z.string().optional(),
      }),
    )
    .min(1),
  status: z.enum(['open', 'ready', 'billed', 'void']),
  pmClaimStatus: z.string().optional(),
  updatedAt: isoDateTime,
});

export const extClaimStatusSchema = z.object({
  encounterExternalId: z.string().min(1),
  patientControlNumber: z.string().optional(),
  status: z.enum(['queued', 'sent', 'accepted', 'rejected', 'paid', 'denied', 'unknown']),
  rejectionReasons: z.array(z.string()).optional(),
  updatedAt: isoDateTime,
});

const extAdjustmentSchema = z.object({
  groupCode: z.enum(['CO', 'PR', 'OA', 'PI', 'CR']),
  carc: z.string().min(1),
  amountCents: cents,
  quantity: z.number().int().optional(),
});

export const extRemittanceSchema = z.object({
  externalId: z.string().min(1),
  payerName: z.string().min(1),
  traceNumber: z.string().min(1),
  paymentMethod: z.enum(['ACH', 'CHK', 'NON']),
  paymentAmountCents: cents,
  paymentDate: isoDate,
  raw835: z.string().optional(),
  claims: z.array(
    z.object({
      patientControlNumber: z.string(),
      payerClaimControlNumber: z.string(),
      statusCode: z.string(),
      chargeCents: cents,
      paidCents: cents,
      patientRespCents: cents,
      adjustments: z.array(extAdjustmentSchema),
      lines: z.array(
        z.object({
          lineControlNumber: z.string().optional(),
          code: z.string(),
          modifiers: z.array(z.string()),
          units: z.number().int(),
          chargeCents: cents,
          allowedCents: cents.optional(),
          paidCents: cents,
          adjustments: z.array(extAdjustmentSchema),
          remarks: z.array(z.string()),
        }),
      ),
    }),
  ),
  providerAdjustments: z.array(
    z.object({ reasonCode: z.string(), reference: z.string(), amountCents: cents }),
  ),
});

export const extPostingSchema = z.object({
  remittanceExternalId: z.string().optional(),
  traceNumber: z.string().min(1),
  encounterExternalId: z.string().min(1),
  lineExternalId: z.string().optional(),
  paidCents: cents,
  adjustments: z.array(z.object({ pmAdjustmentCode: z.string(), amountCents: cents })),
  patientRespCents: cents,
  postedAt: isoDateTime,
});

export const PULL_SCHEMAS = {
  pullPatientsAndCoverage: extPatientSchema,
  pullCharges: extEncounterSchema,
  pullClaimsAndStatus: extClaimStatusSchema,
  pullRemittances: extRemittanceSchema,
  pullPostings: extPostingSchema,
} as const;

export type PullOperation = keyof typeof PULL_SCHEMAS;
export const PULL_OPERATIONS = Object.keys(PULL_SCHEMAS) as PullOperation[];
