import 'server-only';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import {
  claimEvents,
  claims,
  claimVersions,
  clients,
  connections,
  coverages,
  eligibilityChecks,
  encounters,
  patients,
  payers,
  providers,
  scrubResults,
  users,
  withAudit,
  withTenant,
  workItems,
  type Tx,
} from '@cleanpost/db';
import { diffPayload, policy, type ClaimPayload, type Finding } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';
import { patientLabel } from './work';

const NONE = '00000000-0000-0000-0000-000000000000';
const CLOSED = ['closed', 'voided', 'paid'];
const PAGE = 50;

/** C-01 saved views (docs/09): the filter each tab applies. */
export const CLAIM_VIEWS = [
  { key: 'open', label: 'All open' },
  { key: 'review', label: 'Needs review' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'denied', label: 'Denied' },
  { key: 'awaiting', label: 'Awaiting payment over 30 days' },
  { key: 'deadline', label: 'Filing deadline under 30 days' },
  { key: 'closed', label: 'Closed' },
] as const;
export type ClaimView = (typeof CLAIM_VIEWS)[number]['key'];

function viewWhere(view: ClaimView, today: string): SQL {
  const in30 = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const ago30 = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  switch (view) {
    case 'review':
      return inArray(claims.status, ['needs_review', 'blocked']);
    case 'rejected':
      return eq(claims.status, 'rejected');
    case 'denied':
      return eq(claims.status, 'denied');
    case 'awaiting':
      return and(inArray(claims.status, ['submitted', 'accepted']), lt(encounters.dateOfService, ago30))!;
    case 'deadline':
      return and(
        notInArray(claims.status, [...CLOSED, 'submitted', 'accepted']),
        lte(claims.filingDeadline, in30),
      )!;
    case 'closed':
      return inArray(claims.status, CLOSED);
    default:
      return notInArray(claims.status, CLOSED);
  }
}

export interface ClaimFilters {
  view: ClaimView;
  q: string;
  clientId: string | null;
  payerId: string | null;
  status: string | null;
  page: number;
}

export interface ClaimRowView {
  id: string;
  patient: string;
  dateOfService: string;
  clientName: string;
  mode: 'A' | 'B' | 'C';
  payerName: string | null;
  chargeCents: number;
  balanceCents: number;
  status: string;
  lastEvent: string | null;
}

function scope(ctx: ActiveContext): SQL | undefined {
  const s = policy.clientFilter(ctx.actor);
  return s === 'all' ? undefined : inArray(claims.clientId, s.length ? [...s] : [NONE]);
}

/** C-01: one page of claims for a saved view, with counts per view and open totals. */
export async function listClaims(ctx: ActiveContext, f: ClaimFilters, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const base: (SQL | undefined)[] = [scope(ctx)];
    if (f.clientId) base.push(eq(claims.clientId, f.clientId));
    if (f.payerId) base.push(eq(claims.payerId, f.payerId));
    if (f.status) base.push(eq(claims.status, f.status));
    const q = f.q.trim();
    if (q)
      base.push(
        or(ilike(patients.lastName, `${q.replace(/[%_]/g, '')}%`), eq(claims.patientControlNumber, q)),
      );
    const from = () =>
      tx
        .select({ n: count() })
        .from(claims)
        .innerJoin(encounters, eq(encounters.id, claims.encounterId))
        .innerJoin(patients, eq(patients.id, claims.patientId));
    const counts: Record<string, number> = {};
    for (const v of CLAIM_VIEWS) {
      const [r] = await from().where(and(...base, viewWhere(v.key, today)));
      counts[v.key] = r?.n ?? 0;
    }
    const [open] = await tx
      .select({ balance: sum(claims.balanceCents) })
      .from(claims)
      .where(
        and(
          scope(ctx),
          f.clientId ? eq(claims.clientId, f.clientId) : undefined,
          notInArray(claims.status, CLOSED),
        ),
      );

    const lastEvent = sql<string | null>`(
      select ${claimEvents.type} from ${claimEvents}
      where ${claimEvents.claimId} = ${claims.id}
      order by ${claimEvents.occurredAt} desc limit 1)`;
    const rows = await withAudit(
      tx,
      (r: unknown[]) => ({
        actor: `user:${ctx.user.id}`,
        action: 'claims_list.viewed',
        entityType: 'claim',
        metadata: { rows: r.length, view: f.view, searched: Boolean(q) },
      }),
      () =>
        tx
          .select({
            id: claims.id,
            lastName: patients.lastName,
            firstName: patients.firstName,
            dos: encounters.dateOfService,
            clientName: clients.name,
            mode: claims.mode,
            payerName: payers.name,
            charge: claims.totalChargeCents,
            balance: claims.balanceCents,
            status: claims.status,
            lastEvent,
          })
          .from(claims)
          .innerJoin(encounters, eq(encounters.id, claims.encounterId))
          .innerJoin(patients, eq(patients.id, claims.patientId))
          .innerJoin(clients, eq(clients.id, claims.clientId))
          .leftJoin(payers, eq(payers.id, claims.payerId))
          .where(and(...base, viewWhere(f.view, today)))
          // Default sort: balance, largest first, within the view (C-01 rules).
          .orderBy(desc(claims.balanceCents), desc(encounters.dateOfService), asc(claims.id))
          .limit(PAGE)
          .offset((f.page - 1) * PAGE),
    );
    const payerRows = await tx
      .selectDistinct({ id: payers.id, name: payers.name })
      .from(claims)
      .innerJoin(payers, eq(payers.id, claims.payerId))
      .where(scope(ctx))
      .orderBy(asc(payers.name));
    return {
      rows: rows.map((r): ClaimRowView => ({
        id: r.id,
        patient: patientLabel({ lastName: r.lastName, firstName: r.firstName })!,
        dateOfService: r.dos,
        clientName: r.clientName,
        mode: r.mode as ClaimRowView['mode'],
        payerName: r.payerName,
        chargeCents: r.charge,
        balanceCents: r.balance,
        status: r.status,
        lastEvent: r.lastEvent,
      })),
      counts,
      total: counts[f.view] ?? 0,
      openBalanceCents: Number(open?.balance ?? 0),
      payers: payerRows,
      pageSize: PAGE,
    };
  });
}

export interface ClaimEventView {
  id: string;
  type: string;
  actor: string;
  actorName: string | null;
  occurredAt: Date;
  versionNumber: number | null;
  payload: Record<string, unknown>;
}

export interface ClaimVersionView {
  id: string;
  version: number;
  frequencyCode: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: Date;
  releasedAt: Date | null;
  confidence: number | null;
  decision: string | null;
  totalChargeCents: number;
  /** Against the version before: "Line 1 modifier 25 added", with the values (C-10). */
  changes: { label: string; fieldPath: string; before: unknown; after: unknown }[];
}

export interface ClaimDetail {
  claim: typeof claims.$inferSelect;
  clientName: string;
  threshold: number;
  pmName: string;
  payerName: string | null;
  patient: string;
  ageYears: number | null;
  renderingNpi: string | null;
  payload: ClaimPayload;
  versionId: string;
  versionNumber: number;
  scrub: {
    confidence: number;
    decision: string;
    findings: Finding[];
    deductions: { reason: string; points: number }[];
    aiSummary: string | null;
    rulesVersion: string;
    scrubbedAt: Date;
  } | null;
  openItem: { id: string; type: string; summary: string; dueAt: Date; assigneeName: string | null } | null;
  correctionPending: boolean;
  events: ClaimEventView[];
  versions: ClaimVersionView[];
}

function ageAt(dob: string, dos: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [y, m, d] = dos.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

async function loadClaim(tx: Tx, ctx: ActiveContext, id: string): Promise<ClaimDetail | null> {
  const [row] = await tx
    .select({
      claim: claims,
      clientName: clients.name,
      threshold: clients.autoReleaseThreshold,
      payerName: payers.name,
      patient: patients,
    })
    .from(claims)
    .innerJoin(clients, eq(clients.id, claims.clientId))
    .innerJoin(patients, eq(patients.id, claims.patientId))
    .leftJoin(payers, eq(payers.id, claims.payerId))
    .where(and(eq(claims.id, id), scope(ctx)));
  if (!row?.claim.currentVersionId) return null;
  const c = row.claim;
  const versionRows = await tx
    .select({ v: claimVersions, s: scrubResults, name: users.name })
    .from(claimVersions)
    .leftJoin(scrubResults, eq(scrubResults.id, claimVersions.scrubResultId))
    .leftJoin(users, sql`${claimVersions.createdBy} = 'user:' || ${users.id}::text`)
    .where(eq(claimVersions.claimId, c.id))
    .orderBy(desc(claimVersions.version));
  const current = versionRows.find((r) => r.v.id === c.currentVersionId)!;
  const payload = current.v.payload as ClaimPayload;
  const events = await tx
    .select({ e: claimEvents, name: users.name })
    .from(claimEvents)
    .leftJoin(users, sql`${claimEvents.actor} = 'user:' || ${users.id}::text`)
    .where(eq(claimEvents.claimId, c.id))
    .orderBy(desc(claimEvents.occurredAt), desc(claimEvents.createdAt))
    .limit(200);
  const [item] = await tx
    .select({
      id: workItems.id,
      type: workItems.type,
      summary: workItems.summary,
      dueAt: workItems.dueAt,
      assigneeName: users.name,
    })
    .from(workItems)
    .leftJoin(users, eq(users.id, workItems.assigneeId))
    .where(and(eq(workItems.claimId, c.id), sql`${workItems.status} <> 'resolved'`))
    .orderBy(asc(workItems.priority), asc(workItems.dueAt))
    .limit(1);
  const [pending] = await tx
    .select({ n: count() })
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, c.id),
        eq(workItems.reasonCode, 'pushChargeCorrection'),
        sql`${workItems.status} <> 'resolved'`,
      ),
    );
  const [conn] = await tx
    .select({ settings: connections.settings })
    .from(connections)
    .where(eq(connections.clientId, c.clientId))
    .limit(1);
  const [prov] = payload.rendering
    ? await tx
        .select({ npi: providers.npi })
        .from(providers)
        .where(eq(providers.id, payload.rendering.providerId))
    : [];
  const s = current.s;
  const stored = (s?.findings ?? null) as {
    items?: Finding[];
    deductions?: { reason: string; points: number }[];
  } | null;
  const versionNo = new Map(versionRows.map((r) => [r.v.id, r.v.version]));
  // What changed in each version, against the one before it (C-05): codes and field paths only.
  const byNumber = new Map(versionRows.map((r) => [r.v.version, r.v.payload as ClaimPayload]));
  const changesFor = (v: (typeof versionRows)[number]) => {
    const prev = byNumber.get(v.v.version - 1);
    return prev
      ? diffPayload(prev, v.v.payload as ClaimPayload).map(({ label, fieldPath, before, after }) => ({
          label,
          fieldPath,
          before,
          after,
        }))
      : [];
  };
  return {
    claim: c,
    clientName: row.clientName,
    threshold: row.threshold,
    pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
    payerName: row.payerName ?? payload.payerName,
    patient: patientLabel(row.patient)!,
    ageYears: ageAt(row.patient.dob, payload.dateOfService),
    renderingNpi: prov?.npi ?? payload.rendering?.npi ?? null,
    payload,
    versionId: current.v.id,
    versionNumber: current.v.version,
    scrub: s
      ? {
          confidence: s.confidence,
          decision: s.decision,
          findings: stored?.items ?? [],
          deductions: stored?.deductions ?? [],
          aiSummary: s.aiSummary,
          rulesVersion: s.rulesVersion,
          scrubbedAt: s.createdAt,
        }
      : null,
    openItem: item
      ? {
          id: item.id,
          type: item.type,
          summary: item.summary,
          dueAt: item.dueAt,
          assigneeName: item.assigneeName,
        }
      : null,
    correctionPending: (pending?.n ?? 0) > 0,
    events: events.map((r) => ({
      id: r.e.id,
      type: r.e.type,
      actor: r.e.actor,
      actorName: r.name,
      occurredAt: r.e.occurredAt,
      versionNumber: r.e.claimVersionId ? (versionNo.get(r.e.claimVersionId) ?? null) : null,
      payload: (r.e.payload ?? {}) as Record<string, unknown>,
    })),
    versions: versionRows.map((r) => ({
      id: r.v.id,
      version: r.v.version,
      frequencyCode: r.v.frequencyCode,
      createdBy: r.v.createdBy,
      createdByName: r.name,
      createdAt: r.v.createdAt,
      releasedAt: r.v.releasedAt,
      confidence: r.s?.confidence ?? null,
      decision: r.s?.decision ?? null,
      totalChargeCents: (r.v.payload as ClaimPayload).totalChargeCents,
      changes: changesFor(r),
    })),
  };
}

/** C-02 to C-05: one claim with its versions, scrub, events and open item. Audited (C-02 rules). */
export async function getClaim(ctx: ActiveContext, id: string): Promise<ClaimDetail | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    withAudit(
      tx,
      (d: ClaimDetail | null) => ({
        actor: `user:${ctx.user.id}`,
        action: 'claim.viewed',
        entityType: 'claim',
        entityId: id,
        clientId: d?.claim.clientId ?? null,
      }),
      () => loadClaim(tx, ctx, id),
    ),
  );
}

export interface ClaimCoverageView {
  patient: { label: string; dobMasked: string; sex: string };
  coverage: {
    id: string;
    payerName: string;
    priority: number;
    memberIdMasked: string;
    groupNumber: string | null;
    relationship: string;
    effectiveDate: string | null;
    terminationDate: string | null;
    changedAfterRelease: boolean;
  } | null;
  eligibility: {
    status: string;
    requestedAt: Date;
    summary: Record<string, unknown>;
  } | null;
}

/** C-06: masked by default (last 4 of the member ID, year of birth); the full values need G-12. */
export async function getClaimCoverage(
  ctx: ActiveContext,
  claimId: string,
): Promise<ClaimCoverageView | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    withAudit(
      tx,
      (v: ClaimCoverageView | null) => ({
        actor: `user:${ctx.user.id}`,
        action: 'claim.coverage_viewed',
        entityType: 'claim',
        entityId: claimId,
        metadata: { masked: true, found: Boolean(v) },
      }),
      async () => {
        const [row] = await tx
          .select({ claim: claims, patient: patients, coverage: coverages })
          .from(claims)
          .innerJoin(patients, eq(patients.id, claims.patientId))
          .leftJoin(coverages, eq(coverages.id, claims.coverageId))
          .where(and(eq(claims.id, claimId), scope(ctx)));
        if (!row) return null;
        const [released] = row.claim.currentVersionId
          ? await tx
              .select({ at: claimVersions.releasedAt })
              .from(claimVersions)
              .where(eq(claimVersions.id, row.claim.currentVersionId))
          : [];
        const [check] = row.coverage
          ? await tx
              .select()
              .from(eligibilityChecks)
              .where(eq(eligibilityChecks.coverageId, row.coverage.id))
              .orderBy(desc(eligibilityChecks.requestedAt))
              .limit(1)
          : [];
        const c = row.coverage;
        return {
          patient: {
            label: patientLabel(row.patient)!,
            dobMasked: `••/••/${row.patient.dob.slice(0, 4)}`,
            sex: row.patient.sex,
          },
          coverage: c
            ? {
                id: c.id,
                payerName: c.payerName,
                priority: c.priority,
                memberIdMasked: `•••••${c.memberIdLast4}`,
                groupNumber: c.groupNumber,
                relationship: c.relationship,
                effectiveDate: c.effectiveDate,
                terminationDate: c.terminationDate,
                changedAfterRelease: Boolean(released?.at && c.updatedAt > released.at),
              }
            : null,
          eligibility: check
            ? {
                status: check.status,
                requestedAt: check.requestedAt,
                summary: (check.summary ?? {}) as Record<string, unknown>,
              }
            : null,
        };
      },
    ),
  );
}
