import 'server-only';
import { and, asc, desc, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  claimEvents,
  claims,
  clientPayerSettings,
  clients,
  encounters,
  patients,
  payers,
  remittances,
  users,
  withAudit,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { policy, remit } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';
import { getWorkDetail, patientLabel, type WorkDetail } from './work';
import { writeOffOptions, type WriteOffOptions } from './write-off';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface DenialRow {
  itemId: string;
  claimId: string | null;
  clientId: string | null;
  patient: string | null;
  dateOfService: string | null;
  clientName: string | null;
  payerName: string | null;
  carc: string;
  kind: remit.DenialKind;
  amountCents: number;
  /** What a bulk write-off (D-03) takes: the denied amount, capped at the claim's balance. */
  writeOffCents: number;
  createdAt: Date;
  assigned: boolean;
}

function scope(ctx: ActiveContext): SQL | undefined {
  const s = policy.clientFilter(ctx.actor);
  return s === 'all' ? undefined : inArray(workItems.clientId, s.length ? [...s] : [NONE]);
}

/** D-01: open denials by category (open balance at risk, not billed charges) and the list. */
export async function listDenials(
  ctx: ActiveContext,
  f: { kind: remit.DenialKind | null; clientId: string | null },
) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const base = [
      scope(ctx),
      eq(workItems.type, 'denial'),
      ne(workItems.status, 'resolved'),
      f.clientId ? eq(workItems.clientId, f.clientId) : undefined,
    ];
    const rows = await withAudit(
      tx,
      (r: unknown[]) => ({
        actor: `user:${ctx.user.id}`,
        action: 'denials_list.viewed',
        entityType: 'work_item',
        metadata: { rows: r.length },
      }),
      () =>
        tx
          .select({
            itemId: workItems.id,
            claimId: workItems.claimId,
            clientId: workItems.clientId,
            lastName: patients.lastName,
            firstName: patients.firstName,
            dos: encounters.dateOfService,
            clientName: clients.name,
            payerName: payers.name,
            carc: workItems.reasonCode,
            amountCents: workItems.amountCents,
            balanceCents: claims.balanceCents,
            createdAt: workItems.createdAt,
            assigneeId: workItems.assigneeId,
          })
          .from(workItems)
          .leftJoin(claims, eq(claims.id, workItems.claimId))
          .leftJoin(patients, eq(patients.id, claims.patientId))
          .leftJoin(encounters, eq(encounters.id, claims.encounterId))
          .leftJoin(clients, eq(clients.id, workItems.clientId))
          .leftJoin(payers, eq(payers.id, claims.payerId))
          .where(and(...base))
          .orderBy(desc(workItems.amountCents), desc(workItems.createdAt))
          .limit(500),
    );
    const all = rows.map((r): DenialRow => ({
      itemId: r.itemId,
      claimId: r.claimId,
      clientId: r.clientId,
      patient:
        r.lastName && r.firstName ? patientLabel({ lastName: r.lastName, firstName: r.firstName }) : null,
      dateOfService: r.dos,
      clientName: r.clientName,
      payerName: r.payerName,
      carc: r.carc,
      kind: remit.denialKind(r.carc),
      amountCents: Number(r.amountCents ?? 0),
      writeOffCents: remit.writeOffDefaultCents(Number(r.amountCents ?? 0), Number(r.balanceCents ?? 0)),
      createdAt: r.createdAt,
      assigned: Boolean(r.assigneeId),
    }));
    const byKind = new Map<remit.DenialKind, { count: number; cents: number }>();
    for (const r of all) {
      const k = byKind.get(r.kind) ?? { count: 0, cents: 0 };
      k.count++;
      k.cents += r.amountCents;
      byKind.set(r.kind, k);
    }
    // This month: denials closed by a corrected claim, and written off.
    const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z');
    const closed = await tx
      .select({
        resolution: workItems.resolution,
        n: sql<number>`count(*)::int`,
        cents: sql<number>`coalesce(sum(${workItems.amountCents}), 0)::bigint`,
      })
      .from(workItems)
      .where(
        and(
          scope(ctx),
          eq(workItems.type, 'denial'),
          eq(workItems.status, 'resolved'),
          gte(workItems.resolvedAt, monthStart),
        ),
      )
      .groupBy(workItems.resolution);
    const of = (why: string) => closed.find((c) => c.resolution === why);
    return {
      rows: f.kind ? all.filter((r) => r.kind === f.kind) : all,
      totals: { count: all.length, cents: all.reduce((s, r) => s + r.amountCents, 0) },
      byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.cents - a.cents),
      month: {
        corrected: {
          count: of('Corrected claim accepted')?.n ?? 0,
          cents: Number(of('Corrected claim accepted')?.cents ?? 0),
        },
        writtenOff: { count: of('Written off')?.n ?? 0, cents: Number(of('Written off')?.cents ?? 0) },
      },
    };
  });
}

export interface DenialDrawer {
  detail: WorkDetail;
  /** The claim's events, oldest first (D-02 History). */
  history: { type: string; actor: string; payload: Record<string, unknown>; occurredAt: Date }[];
  /** Where the denial came from: the 835's source and date. */
  source: { kind: string; paymentDate: string; payerName: string; traceNumber: string } | null;
  /** Corrected claim by: the client's filing limit for the payer from the denial date. */
  deadline: { date: string; filingDays: number } | null;
  /** Denials of the same code from the same payer for this client (D-02 "similar denials"). */
  similar: { total: number; corrected: number; writtenOff: number; open: number };
  assigneeName: string | null;
  pmName: string;
}

/** D-02 Denial detail: the W-16 detail plus history, deadline and similar denials. A PHI read. */
export async function getDenialDrawer(ctx: ActiveContext, itemId: string): Promise<DenialDrawer | null> {
  const detail = await getWorkDetail(ctx, itemId);
  if (!detail || detail.item.type !== 'denial' || !detail.claim) return null;
  const item = detail.item;
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, detail.claim!.id));
    const history = await tx
      .select({
        type: claimEvents.type,
        actor: claimEvents.actor,
        payload: claimEvents.payload,
        occurredAt: claimEvents.occurredAt,
      })
      .from(claimEvents)
      .where(eq(claimEvents.claimId, detail.claim!.id))
      .orderBy(asc(claimEvents.occurredAt));
    const [r] = item.remittanceId
      ? await tx
          .select({
            kind: remittances.source,
            paymentDate: remittances.paymentDate,
            payerName: remittances.payerName,
            traceNumber: remittances.traceNumber,
          })
          .from(remittances)
          .where(eq(remittances.id, item.remittanceId))
      : [];
    const [cps] =
      claim?.payerId && item.clientId
        ? await tx
            .select({ days: clientPayerSettings.timelyFilingDays })
            .from(clientPayerSettings)
            .where(
              and(
                eq(clientPayerSettings.clientId, item.clientId),
                eq(clientPayerSettings.payerId, claim.payerId),
              ),
            )
        : [];
    const filingDays = cps?.days ?? 90;
    const others =
      claim?.payerId && item.clientId
        ? await tx
            .select({ status: workItems.status, resolution: workItems.resolution })
            .from(workItems)
            .innerJoin(claims, eq(claims.id, workItems.claimId))
            .where(
              and(
                eq(workItems.type, 'denial'),
                eq(workItems.clientId, item.clientId),
                eq(workItems.reasonCode, item.reasonCode),
                eq(claims.payerId, claim.payerId),
                ne(workItems.id, item.id),
              ),
            )
        : [];
    const [assignee] = item.assigneeId
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, item.assigneeId))
      : [];
    return {
      detail,
      history: history.map((h) => ({ ...h, payload: (h.payload ?? {}) as Record<string, unknown> })),
      source: r ?? null,
      deadline: r ? { date: remit.correctionDeadline(r.paymentDate, filingDays), filingDays } : null,
      similar: {
        total: others.length,
        corrected: others.filter((o) => o.resolution?.startsWith('Corrected')).length,
        writtenOff: others.filter((o) => o.resolution?.startsWith('Written off')).length,
        open: others.filter((o) => o.status !== 'resolved').length,
      },
      assigneeName: assignee?.name ?? null,
      pmName: detail.connection?.pmName ?? 'the PM',
    };
  });
}

/** D-03 bulk: each client's write-off options (PM name, codes, limit). */
export async function writeOffOptionsFor(
  ctx: ActiveContext,
  clientIds: string[],
): Promise<Record<string, WriteOffOptions>> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const out: Record<string, WriteOffOptions> = {};
    for (const id of new Set(clientIds)) out[id] = await writeOffOptions(tx, ctx.tenantId, id);
    return out;
  });
}
