import 'server-only';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import {
  claimEvents,
  claims,
  claimVersions,
  clients,
  connections,
  manualTasks,
  patients,
  payers,
  scrubResults,
  users,
  withAudit,
  withTenant,
  workItems,
  type Tx,
} from '@cleanpost/db';
import { policy, work, type ClaimPayload, type Finding } from '@cleanpost/domain';
import { wakeDueItems } from '@cleanpost/work';
import { pacificDay } from '../format';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface WorkFilters {
  group: string;
  clientId: string | null;
  payerId: string | null;
  /** me | unassigned | anyone */
  assignee: 'me' | 'unassigned' | 'anyone';
  /** Show snoozed items instead of the live queue (W-03 "Show snoozed items"). */
  snoozed: boolean;
}

export interface WorkRow {
  id: string;
  type: string;
  priority: 1 | 2 | 3 | 4;
  status: string;
  dueAt: Date;
  snoozedUntil: Date | null;
  summary: string;
  amountCents: number | null;
  claimId: string | null;
  clientId: string | null;
  clientName: string | null;
  mode: 'A' | 'B' | 'C' | null;
  /** "Nguyen, M.": reduced identifiers only in lists (docs/09). */
  patient: string | null;
  payerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
}

export interface WorkQueue {
  rows: WorkRow[];
  /** Per chip, for the current client, payer and assignee filters. */
  counts: Record<string, number>;
  total: number;
  /** Items in scope that are not resolved, before any filter: decides W-03. */
  openInScope: number;
  snoozedInScope: number;
  kpis: {
    dueToday: number;
    overdue: number;
    readyToRelease: number;
    releasedToday: number;
    releasedWithoutReviewToday: number;
  };
  payers: { id: string; name: string }[];
  clientsInQueue: number;
}

export const patientLabel = (p: { lastName: string; firstName: string } | null) =>
  p ? `${p.lastName}, ${p.firstName.slice(0, 1)}.` : null;

/** Items this person may see: their clients (billers), and connection and system items for admins. */
function scopeWhere(ctx: ActiveContext): SQL[] {
  const scope = policy.clientFilter(ctx.actor);
  const where: SQL[] = [];
  if (scope !== 'all') where.push(inArray(workItems.clientId, scope.length ? [...scope] : [NONE]));
  if (ctx.actor.role !== 'admin') where.push(sql`${workItems.type} not in ('sync_failure', 'system')`);
  return where;
}

function claimScope(ctx: ActiveContext): SQL | undefined {
  const scope = policy.clientFilter(ctx.actor);
  return scope === 'all' ? undefined : inArray(claims.clientId, scope.length ? [...scope] : [NONE]);
}

const LIMIT = 200;

/** W-01: the queue, its chip counts and today's summary strip. */
export async function listWork(ctx: ActiveContext, f: WorkFilters, now = new Date()): Promise<WorkQueue> {
  const day = pacificDay(now);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    // Snoozed items whose time has come are back in the queue before it is read.
    await wakeDueItems(tx, now);
    const scope = scopeWhere(ctx);
    const live = [ne(workItems.status, 'resolved'), ne(workItems.status, 'snoozed')];
    const filters: SQL[] = [];
    if (f.clientId) filters.push(eq(workItems.clientId, f.clientId));
    if (f.payerId) filters.push(eq(claims.payerId, f.payerId));
    if (f.assignee === 'me') filters.push(eq(workItems.assigneeId, ctx.user.id));
    if (f.assignee === 'unassigned') filters.push(isNull(workItems.assigneeId));
    const state = f.snoozed ? [eq(workItems.status, 'snoozed')] : live;
    const types = work.typesOfGroup(f.group);

    const byType = await tx
      .select({ type: workItems.type, n: count() })
      .from(workItems)
      .leftJoin(claims, eq(claims.id, workItems.claimId))
      .where(and(...scope, ...state, ...filters))
      .groupBy(workItems.type);
    const counts: Record<string, number> = { all: byType.reduce((s, r) => s + r.n, 0) };
    for (const g of work.WORK_TYPE_GROUPS)
      counts[g.key] = byType
        .filter((r) => (g.types as readonly string[]).includes(r.type))
        .reduce((s, r) => s + r.n, 0);

    const rows = await withAudit(
      tx,
      (r: unknown[]) => ({
        actor: `user:${ctx.user.id}`,
        action: 'work_queue.viewed',
        entityType: 'work_item',
        metadata: { rows: r.length, group: f.group, ...(f.clientId ? { clientId: f.clientId } : {}) },
      }),
      () =>
        tx
          .select({
            item: workItems,
            clientName: clients.name,
            clientMode: clients.defaultMode,
            claimMode: claims.mode,
            balanceCents: claims.balanceCents,
            payerName: payers.name,
            lastName: patients.lastName,
            firstName: patients.firstName,
            assigneeName: users.name,
          })
          .from(workItems)
          .leftJoin(clients, eq(clients.id, workItems.clientId))
          .leftJoin(claims, eq(claims.id, workItems.claimId))
          .leftJoin(patients, eq(patients.id, claims.patientId))
          .leftJoin(payers, eq(payers.id, claims.payerId))
          .leftJoin(users, eq(users.id, workItems.assigneeId))
          .where(and(...scope, ...state, ...filters, ...(types ? [inArray(workItems.type, [...types])] : [])))
          // Default sort (docs/08): priority, due time, then amount, largest first.
          .orderBy(
            asc(workItems.priority),
            asc(workItems.dueAt),
            desc(sql`coalesce(${workItems.amountCents}, ${claims.balanceCents}, 0)`),
          )
          .limit(LIMIT),
    );

    const [openInScope] = await tx
      .select({ n: count() })
      .from(workItems)
      .where(and(...scope, ...live));
    const [snoozedInScope] = await tx
      .select({ n: count() })
      .from(workItems)
      .where(and(...scope, eq(workItems.status, 'snoozed')));
    const [dueToday] = await tx
      .select({ n: count() })
      .from(workItems)
      .where(and(...scope, ...live, lte(workItems.dueAt, day.end)));
    const [overdue] = await tx
      .select({ n: count() })
      .from(workItems)
      .where(and(...scope, ...live, lte(workItems.dueAt, now)));
    const cs = claimScope(ctx);
    const clientWhere = f.clientId ? eq(claims.clientId, f.clientId) : undefined;
    const [ready] = await tx
      .select({ n: count() })
      .from(claims)
      .where(and(cs, clientWhere, eq(claims.status, 'ready')));
    const released = await tx
      .select({ actor: claimEvents.actor, via: sql<string | null>`${claimEvents.payload}->>'via'` })
      .from(claimEvents)
      .innerJoin(claims, eq(claims.id, claimEvents.claimId))
      .where(and(cs, clientWhere, eq(claimEvents.type, 'released'), gte(claimEvents.occurredAt, day.start)));
    const fromCleanpost = released.filter((r) => r.via !== 'pm_outside_cleanpost');
    const payerRows = await tx
      .selectDistinct({ id: payers.id, name: payers.name })
      .from(workItems)
      .innerJoin(claims, eq(claims.id, workItems.claimId))
      .innerJoin(payers, eq(payers.id, claims.payerId))
      .where(and(...scope, ...live))
      .orderBy(asc(payers.name));

    const mapped: WorkRow[] = rows.map((r) => ({
      id: r.item.id,
      type: r.item.type,
      priority: Math.min(4, Math.max(1, r.item.priority)) as WorkRow['priority'],
      status: r.item.status,
      dueAt: r.item.dueAt,
      snoozedUntil: r.item.snoozedUntil,
      summary: r.item.summary,
      amountCents: r.item.amountCents ?? r.balanceCents ?? null,
      claimId: r.item.claimId,
      clientId: r.item.clientId,
      clientName: r.clientName,
      mode: (r.claimMode ?? r.clientMode ?? null) as WorkRow['mode'],
      patient:
        r.lastName && r.firstName ? patientLabel({ lastName: r.lastName, firstName: r.firstName }) : null,
      payerName: r.payerName,
      assigneeId: r.item.assigneeId,
      assigneeName: r.assigneeName,
    }));
    return {
      rows: mapped,
      counts,
      total: counts.all ?? 0,
      openInScope: openInScope?.n ?? 0,
      snoozedInScope: snoozedInScope?.n ?? 0,
      kpis: {
        dueToday: dueToday?.n ?? 0,
        overdue: overdue?.n ?? 0,
        readyToRelease: ready?.n ?? 0,
        releasedToday: fromCleanpost.length,
        releasedWithoutReviewToday: fromCleanpost.filter((r) => r.actor.startsWith('automation:')).length,
      },
      payers: payerRows,
      clientsInQueue: new Set(mapped.map((r) => r.clientId).filter(Boolean)).size,
    };
  });
}

export interface ClaimLineView {
  lineNumber: number;
  code: string;
  modifiers: string[];
  units: number;
  dxPointers: number[];
  chargeCents: number;
  /** Lines a finding points at, for the row highlight. */
  flagged: boolean;
}

export interface WorkDetail {
  item: typeof workItems.$inferSelect;
  clientName: string | null;
  threshold: number;
  claim: {
    id: string;
    status: string;
    mode: 'A' | 'B' | 'C';
    pcn: string | null;
    totalChargeCents: number;
    balanceCents: number;
    versionId: string | null;
    version: number | null;
    dateOfService: string | null;
    payerName: string | null;
    patient: string | null;
    ageYears: number | null;
    diagnoses: { sequence: number; icd10: string }[];
    lines: ClaimLineView[];
    /** A correction is waiting to be made in the PM (Mode A, level 0). */
    correctionPending: boolean;
  } | null;
  scrub: {
    confidence: number;
    decision: 'auto_release' | 'review' | 'blocked';
    findings: Finding[];
    aiSummary: string | null;
    deductions: { reason: string; points: number }[];
  } | null;
  connection: { id: string; status: string; pmName: string } | null;
  manualTask: { title: string; instructions: string[]; status: string } | null;
}

function ageAt(dob: string, dos: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [y, m, d] = dos.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

async function loadDetail(tx: Tx, ctx: ActiveContext, id: string): Promise<WorkDetail | null> {
  const [item] = await tx
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), ...scopeWhere(ctx)));
  if (!item) return null;
  const [client] = item.clientId ? await tx.select().from(clients).where(eq(clients.id, item.clientId)) : [];
  const [conn] = item.clientId
    ? await tx.select().from(connections).where(eq(connections.clientId, item.clientId)).limit(1)
    : item.connectionId
      ? await tx.select().from(connections).where(eq(connections.id, item.connectionId))
      : [];
  const [task] = await tx
    .select({ title: manualTasks.title, instructions: manualTasks.instructions, status: manualTasks.status })
    .from(manualTasks)
    .where(eq(manualTasks.workItemId, item.id));

  let claim: WorkDetail['claim'] = null;
  let scrub: WorkDetail['scrub'] = null;
  if (item.claimId) {
    const [c] = await tx
      .select({ claim: claims, payerName: payers.name, patient: patients })
      .from(claims)
      .leftJoin(payers, eq(payers.id, claims.payerId))
      .leftJoin(patients, eq(patients.id, claims.patientId))
      .where(eq(claims.id, item.claimId));
    if (c) {
      const [v] = c.claim.currentVersionId
        ? await tx.select().from(claimVersions).where(eq(claimVersions.id, c.claim.currentVersionId))
        : [];
      const [s] = v?.scrubResultId
        ? await tx.select().from(scrubResults).where(eq(scrubResults.id, v.scrubResultId))
        : [];
      const payload = (v?.payload ?? null) as ClaimPayload | null;
      const stored = (s?.findings ?? null) as {
        items?: Finding[];
        deductions?: { reason: string; points: number }[];
      } | null;
      const findings = stored?.items ?? [];
      const flagged = new Set(
        findings.filter((x) => x.severity !== 'info').flatMap((x) => x.lineNumbers ?? []),
      );
      const [pending] = await tx
        .select({ n: count() })
        .from(workItems)
        .where(
          and(
            eq(workItems.claimId, c.claim.id),
            eq(workItems.reasonCode, 'pushChargeCorrection'),
            ne(workItems.status, 'resolved'),
          ),
        );
      claim = {
        id: c.claim.id,
        status: c.claim.status,
        mode: c.claim.mode as 'A' | 'B' | 'C',
        pcn: c.claim.patientControlNumber,
        totalChargeCents: c.claim.totalChargeCents,
        balanceCents: c.claim.balanceCents,
        versionId: v?.id ?? null,
        version: v?.version ?? null,
        dateOfService: payload?.dateOfService ?? null,
        payerName: c.payerName ?? payload?.payerName ?? null,
        patient: c.patient ? patientLabel(c.patient) : null,
        ageYears: c.patient && payload ? ageAt(c.patient.dob, payload.dateOfService) : null,
        diagnoses: payload?.diagnoses ?? [],
        lines: (payload?.lines ?? []).map((l) => ({
          lineNumber: l.lineNumber,
          code: l.code,
          modifiers: l.modifiers,
          units: l.units,
          dxPointers: l.dxPointers,
          chargeCents: l.chargeCents,
          flagged: flagged.has(l.lineNumber),
        })),
        correctionPending: (pending?.n ?? 0) > 0,
      };
      if (s)
        scrub = {
          confidence: s.confidence,
          decision: s.decision as 'auto_release' | 'review' | 'blocked',
          findings,
          aiSummary: s.aiSummary,
          deductions: stored?.deductions ?? [],
        };
    }
  }
  return {
    item,
    clientName: client?.name ?? null,
    threshold: client?.autoReleaseThreshold ?? 90,
    claim,
    scrub,
    connection: conn
      ? {
          id: conn.id,
          status: conn.status,
          pmName: ((conn.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
        }
      : null,
    manualTask: task ?? null,
  };
}

/** W-10 to W-24 side panel: one item with its claim, scrub and connection. A PHI read, audited. */
export async function getWorkDetail(ctx: ActiveContext, id: string): Promise<WorkDetail | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    withAudit(
      tx,
      (d: WorkDetail | null) => ({
        actor: `user:${ctx.user.id}`,
        action: 'work_item.viewed',
        entityType: 'work_item',
        entityId: id,
        clientId: d?.item.clientId ?? null,
        metadata: d?.claim ? { claimId: d.claim.id } : {},
      }),
      () => loadDetail(tx, ctx, id),
    ),
  );
}

/** For the next-item move after an action: the queue order without the item just handled. */
export function nextAfter(rows: WorkRow[], id: string): string | null {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return rows[0]?.id ?? null;
  return rows[i + 1]?.id ?? rows[i - 1]?.id ?? null;
}
