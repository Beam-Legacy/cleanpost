import 'server-only';
/**
 * P-01 Patient detail and P-03 Eligibility result: one patient's coverage (with the latest 271 per
 * coverage), insurance cards and claims. Viewing is audit-logged (P-01 rules); DOB and member IDs
 * are masked until revealed (G-12).
 */
import { now as clockNow } from '@cleanpost/clock';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  claims,
  clients,
  connections,
  coverages,
  documents,
  eligibilityChecks,
  encounters,
  externalRefs,
  patients,
  payers,
  remitClaims,
  withAudit,
  withTenant,
  type Tx,
} from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface EligibilityView {
  id: string;
  status: string;
  requestedAt: Date;
  planBegin: string | null;
  planEnd: string | null;
  copayCents: number | null;
  deductibleRemainingCents: number | null;
  coinsurancePercent: number | null;
  errorCodes: string[];
}

export interface CoverageView {
  id: string;
  payerName: string;
  payerId: string | null;
  priority: number;
  memberIdMasked: string;
  memberIdLast4: string;
  groupNumber: string | null;
  relationship: string;
  effectiveDate: string | null;
  terminationDate: string | null;
  source: string;
  latest: EligibilityView | null;
}

export interface PatientView {
  id: string;
  clientId: string;
  /** user: corrected in Cleanpost, waiting for the PM to show it (DEC-30). */
  source: string;
  firstName: string;
  lastName: string;
  ageYears: number;
  dobMasked: string;
  sex: string;
  clientName: string;
  pmName: string;
  /** The patient's account number in the PM, when the sync has one. */
  pmAccount: string | null;
  openBalanceCents: number;
  patientRespCents: number;
  openClaims: number;
  lastVisit: string | null;
  coverages: CoverageView[];
  /** P-02: payers a coverage can be moved to. */
  payers: { id: string; name: string }[];
  cards: { id: string; type: string; createdAt: Date; reviewStatus: string }[];
  claims: {
    id: string;
    dateOfService: string;
    payerName: string | null;
    chargeCents: number;
    paidCents: number;
    balanceCents: number;
    status: string;
  }[];
}

const OPEN = [
  'built',
  'needs_review',
  'blocked',
  'on_hold',
  'ready',
  'submitted',
  'accepted',
  'denied',
  'partially_paid',
  'rejected',
  'corrected',
];

const ageAt = (dob: string, on = clockNow()) => {
  const b = new Date(`${dob}T00:00:00Z`);
  let age = on.getUTCFullYear() - b.getUTCFullYear();
  const m = on.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < b.getUTCDate())) age--;
  return age;
};

export function eligibilityView(row: typeof eligibilityChecks.$inferSelect): EligibilityView {
  const s = (row.summary ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : null);
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    planBegin: str('planBegin'),
    planEnd: str('planEnd'),
    copayCents: num('copayCents'),
    deductibleRemainingCents: num('deductibleRemainingCents'),
    coinsurancePercent: num('coinsurancePercent'),
    errorCodes: Array.isArray(s.errorCodes) ? (s.errorCodes as string[]) : [],
  };
}

/** The patient's coverages in order, each with its latest 271 (P-01, W-13, P-02). */
export async function coverageViews(tx: Tx, patientId: string): Promise<CoverageView[]> {
  const covRows = await tx
    .select()
    .from(coverages)
    .where(eq(coverages.patientId, patientId))
    .orderBy(asc(coverages.priority));
  const checks = covRows.length
    ? await tx
        .select()
        .from(eligibilityChecks)
        .where(
          inArray(
            eligibilityChecks.coverageId,
            covRows.map((c) => c.id),
          ),
        )
        .orderBy(desc(eligibilityChecks.requestedAt))
    : [];
  return covRows.map((c) => {
    const latest = checks.find((k) => k.coverageId === c.id);
    return {
      id: c.id,
      payerName: c.payerName,
      payerId: c.payerId,
      priority: c.priority,
      memberIdMasked: `•••••${c.memberIdLast4}`,
      memberIdLast4: c.memberIdLast4,
      groupNumber: c.groupNumber,
      relationship: c.relationship,
      effectiveDate: c.effectiveDate,
      terminationDate: c.terminationDate,
      source: c.source,
      latest: latest ? eligibilityView(latest) : null,
    };
  });
}

/** Payers a coverage can be moved to (P-02), by name. */
export async function payerOptions(tx: Tx): Promise<{ id: string; name: string }[]> {
  return tx.select({ id: payers.id, name: payers.name }).from(payers).orderBy(asc(payers.name));
}

export interface PatientEditView {
  id: string;
  firstName: string;
  lastName: string;
  dob: string;
  sex: 'M' | 'F' | 'U';
  address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string } | null;
  phone: string | null;
  pmName: string;
}

/** P-06: the details being corrected, shown in full to edit them. A PHI read, audited as a reveal. */
export async function getPatientForEdit(ctx: ActiveContext, id: string): Promise<PatientEditView | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [p] = await tx.select().from(patients).where(eq(patients.id, id));
    if (!p || !policy.authorize(ctx.actor, 'claim.edit', { clientId: p.clientId }).allowed) return null;
    const [conn] = await tx
      .select({ settings: connections.settings })
      .from(connections)
      .where(eq(connections.clientId, p.clientId))
      .limit(1);
    return withAudit(
      tx,
      {
        actor: `user:${ctx.user.id}`,
        action: 'phi.revealed',
        entityType: 'patient',
        entityId: p.id,
        clientId: p.clientId,
        metadata: { fields: ['dob', 'address', 'phone'], purpose: 'edit' },
      },
      async () => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        dob: p.dob,
        sex: p.sex as 'M' | 'F' | 'U',
        address: (p.address ?? null) as PatientEditView['address'],
        phone: p.phone,
        pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
      }),
    );
  });
}

async function load(tx: Tx, ctx: ActiveContext, id: string): Promise<PatientView | null> {
  const scope = policy.clientFilter(ctx.actor);
  const [row] = await tx
    .select({ p: patients, clientName: clients.name })
    .from(patients)
    .innerJoin(clients, eq(clients.id, patients.clientId))
    .where(
      and(
        eq(patients.id, id),
        scope === 'all' ? undefined : inArray(patients.clientId, scope.length ? [...scope] : [NONE]),
      ),
    );
  if (!row) return null;
  const p = row.p;
  const [conn] = await tx
    .select({ settings: connections.settings })
    .from(connections)
    .where(eq(connections.clientId, p.clientId))
    .limit(1);
  const [ref] = await tx
    .select({ externalId: externalRefs.externalId })
    .from(externalRefs)
    .where(and(eq(externalRefs.entityType, 'patient'), eq(externalRefs.entityId, p.id)))
    .limit(1);
  const cards = await tx
    .select({
      id: documents.id,
      type: documents.type,
      createdAt: documents.createdAt,
      reviewStatus: documents.reviewStatus,
    })
    .from(documents)
    .where(
      and(
        eq(documents.patientId, p.id),
        inArray(documents.type, ['insurance_card_front', 'insurance_card_back']),
      ),
    )
    .orderBy(desc(documents.createdAt));
  const claimRows = await tx
    .select({ c: claims, dos: encounters.dateOfService, payerName: payers.name })
    .from(claims)
    .innerJoin(encounters, eq(encounters.id, claims.encounterId))
    .leftJoin(payers, eq(payers.id, claims.payerId))
    .where(and(eq(claims.patientId, p.id), ne(claims.status, 'voided')))
    .orderBy(desc(encounters.dateOfService));
  const paid = claimRows.length
    ? await tx
        .select({
          claimId: remitClaims.claimId,
          paid: sql<number>`coalesce(sum(${remitClaims.paidCents}), 0)::bigint`,
          patient: sql<number>`coalesce(sum(${remitClaims.patientRespCents}), 0)::bigint`,
        })
        .from(remitClaims)
        .where(
          inArray(
            remitClaims.claimId,
            claimRows.map((r) => r.c.id),
          ),
        )
        .groupBy(remitClaims.claimId)
    : [];
  const paidBy = new Map(paid.map((r) => [r.claimId, { paid: Number(r.paid), patient: Number(r.patient) }]));
  const open = claimRows.filter((r) => OPEN.includes(r.c.status));
  return {
    id: p.id,
    clientId: p.clientId,
    source: p.source,
    firstName: p.firstName,
    lastName: p.lastName,
    ageYears: ageAt(p.dob),
    dobMasked: `••/••/${p.dob.slice(0, 4)}`,
    sex: p.sex,
    clientName: row.clientName,
    pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
    pmAccount: ref?.externalId ?? null,
    openBalanceCents: open.reduce((s, r) => s + Number(r.c.balanceCents), 0),
    patientRespCents: claimRows.reduce((s, r) => s + (paidBy.get(r.c.id)?.patient ?? 0), 0),
    openClaims: open.length,
    lastVisit: claimRows[0]?.dos ?? null,
    coverages: await coverageViews(tx, p.id),
    payers: await payerOptions(tx),
    cards,
    claims: claimRows.map((r) => ({
      id: r.c.id,
      dateOfService: r.dos,
      payerName: r.payerName,
      chargeCents: Number(r.c.totalChargeCents),
      paidCents: paidBy.get(r.c.id)?.paid ?? 0,
      balanceCents: Number(r.c.balanceCents),
      status: r.c.status,
    })),
  };
}

/** P-01: one patient. A PHI read, audited. */
export async function getPatient(ctx: ActiveContext, id: string): Promise<PatientView | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    withAudit(
      tx,
      (v: PatientView | null) => ({
        actor: `user:${ctx.user.id}`,
        action: 'patient.viewed',
        entityType: 'patient',
        entityId: id,
        clientId: v?.clientId ?? null,
      }),
      () => load(tx, ctx, id),
    ),
  );
}
