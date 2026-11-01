/**
 * pm-mock's JSON -> contract records. Every item is parsed with Zod first (CLAUDE.md: validate at
 * the boundary); an item that does not parse is reported by record ID and field, never by value.
 */
import { z } from 'zod';
import type { ExtClaimStatus, ExtEncounter, ExtPatient, ExtPosting, ExtRemittance, Page } from '../contract';
import { extRemittanceSchema } from '../schemas';

const sex = z.enum(['M', 'F', 'U']);

export const pmPatient = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  sex,
  address: z.object({ line1: z.string(), city: z.string(), state: z.string(), zip: z.string() }).optional(),
  phone: z.string().optional(),
  policies: z.array(
    z.object({
      id: z.string(),
      payerName: z.string(),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      memberId: z.string(),
      groupNumber: z.string().optional(),
      relationship: z.enum(['self', 'spouse', 'child', 'other']),
      subscriber: z.object({ firstName: z.string(), lastName: z.string(), dob: z.string(), sex }).optional(),
      effectiveDate: z.string().optional(),
      terminationDate: z.string().optional(),
    }),
  ),
  updatedAt: z.string(),
});

export const pmEncounter = z.object({
  id: z.string(),
  patientId: z.string(),
  dateOfService: z.string(),
  renderingProviderNpi: z.string(),
  referringProviderNpi: z.string().optional(),
  locationId: z.string(),
  placeOfService: z.string(),
  priorAuthNumber: z.string().optional(),
  diagnoses: z.array(z.object({ sequence: z.number(), code: z.string() })),
  charges: z.array(
    z.object({
      id: z.string(),
      line: z.number(),
      code: z.string(),
      modifiers: z.array(z.string()),
      units: z.number(),
      amountCents: z.number().int(),
      diagnosisPointers: z.array(z.number()),
      ndc: z.string().optional(),
    }),
  ),
  status: z.enum(['open', 'ready', 'billed', 'void']).optional(),
  onHold: z.boolean().optional(),
  workflowStatus: z.enum(['Draft', 'Review', 'Approved', 'Rejected']).optional(),
  patientControlNumber: z.string().optional(),
  updatedAt: z.string(),
});

export const pmClaim = z.object({
  encounterId: z.string(),
  patientControlNumber: z.string(),
  status: z.string(),
  rejectionReasons: z.array(z.string()),
  updatedAt: z.string(),
});

export const pmPosting = z.object({
  paymentId: z.string(),
  traceNumber: z.string(),
  encounterId: z.string(),
  chargeId: z.string().optional(),
  paidCents: z.number().int(),
  adjustments: z.array(z.object({ code: z.string(), amountCents: z.number().int() })),
  patientRespCents: z.number().int(),
  postedAt: z.string(),
});

export const pmRemittance = z.object({
  id: z.string(),
  receivedAt: z.string(),
  era: z.record(z.string(), z.unknown()),
});

export const pmPage = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });

/** Tebra's workflow, in contract terms: Review is ready and held; Approved has gone to billing. */
const WORKFLOW: Record<string, ExtEncounter['status']> = {
  Draft: 'open',
  Review: 'ready',
  Approved: 'billed',
  Rejected: 'open',
};

const CLAIM_STATUSES = new Set(['queued', 'sent', 'accepted', 'rejected', 'paid', 'denied']);

export function toPatient(p: z.infer<typeof pmPatient>): ExtPatient {
  return {
    externalId: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    dob: p.dateOfBirth,
    sex: p.sex,
    ...(p.address ? { address: p.address } : {}),
    ...(p.phone ? { phone: p.phone } : {}),
    coverages: p.policies.map((x) => ({
      externalId: x.id,
      payerName: x.payerName,
      priority: x.priority,
      memberId: x.memberId,
      ...(x.groupNumber ? { groupNumber: x.groupNumber } : {}),
      relationship: x.relationship,
      ...(x.subscriber ? { subscriber: x.subscriber } : {}),
      ...(x.effectiveDate ? { effectiveDate: x.effectiveDate } : {}),
      ...(x.terminationDate ? { terminationDate: x.terminationDate } : {}),
    })),
    updatedAt: p.updatedAt,
  };
}

export function toEncounter(e: z.infer<typeof pmEncounter>): ExtEncounter {
  const status = e.workflowStatus ? WORKFLOW[e.workflowStatus]! : (e.status ?? 'open');
  const pmStatus = e.workflowStatus ?? (e.onHold ? 'On hold' : e.status);
  return {
    externalId: e.id,
    patientExternalId: e.patientId,
    dateOfService: e.dateOfService,
    renderingProviderNpi: e.renderingProviderNpi,
    ...(e.referringProviderNpi ? { referringProviderNpi: e.referringProviderNpi } : {}),
    locationExternalId: e.locationId,
    placeOfService: e.placeOfService,
    ...(e.priorAuthNumber ? { priorAuthNumber: e.priorAuthNumber } : {}),
    diagnoses: e.diagnoses.map((d) => ({ sequence: d.sequence, icd10: d.code })),
    lines: [...e.charges]
      .sort((a, b) => a.line - b.line)
      .map((c) => ({
        externalId: c.id,
        code: c.code,
        modifiers: c.modifiers,
        units: c.units,
        chargeCents: c.amountCents,
        diagnosisPointers: c.diagnosisPointers,
        ...(c.ndc ? { ndc: c.ndc } : {}),
      })),
    status,
    ...(pmStatus ? { pmClaimStatus: pmStatus } : {}),
    updatedAt: e.updatedAt,
  };
}

export const toClaimStatus = (c: z.infer<typeof pmClaim>): ExtClaimStatus => ({
  encounterExternalId: c.encounterId,
  patientControlNumber: c.patientControlNumber,
  status: CLAIM_STATUSES.has(c.status) ? (c.status as ExtClaimStatus['status']) : 'unknown',
  ...(c.rejectionReasons.length ? { rejectionReasons: c.rejectionReasons } : {}),
  updatedAt: c.updatedAt,
});

export const toPosting = (p: z.infer<typeof pmPosting>): ExtPosting => ({
  traceNumber: p.traceNumber,
  encounterExternalId: p.encounterId,
  ...(p.chargeId ? { lineExternalId: p.chargeId } : {}),
  paidCents: p.paidCents,
  adjustments: p.adjustments.map((a) => ({ pmAdjustmentCode: a.code, amountCents: a.amountCents })),
  patientRespCents: p.patientRespCents,
  postedAt: p.postedAt,
});

export const toRemittance = (r: z.infer<typeof pmRemittance>): ExtRemittance =>
  extRemittanceSchema.parse({ ...r.era, externalId: r.id }) as ExtRemittance;

/** Parses each item; those that fail are reported by ID and the first field at fault. */
export function mapItems<S extends z.ZodType, T>(
  raw: unknown[],
  schema: S,
  map: (item: z.infer<S>) => T,
  idOf: (item: unknown) => string | null,
): Pick<Page<T>, 'items' | 'rejected'> {
  const items: T[] = [];
  const rejected: { externalId: string | null; field: string }[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      try {
        items.push(map(parsed.data));
        continue;
      } catch (err) {
        const issue = err instanceof z.ZodError ? err.issues[0] : undefined;
        rejected.push({ externalId: idOf(item), field: issue ? issue.path.join('.') : 'record' });
        continue;
      }
    }
    rejected.push({ externalId: idOf(item), field: parsed.error.issues[0]?.path.join('.') || 'record' });
  }
  return rejected.length ? { items, rejected } : { items };
}
