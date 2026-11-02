import 'server-only';
import { and, desc, eq, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  claims,
  clients,
  encounters,
  patients,
  payers,
  withAudit,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { policy, remit } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';
import { patientLabel } from './work';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface DenialRow {
  itemId: string;
  claimId: string | null;
  patient: string | null;
  dateOfService: string | null;
  clientName: string | null;
  payerName: string | null;
  carc: string;
  kind: remit.DenialKind;
  amountCents: number;
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
            lastName: patients.lastName,
            firstName: patients.firstName,
            dos: encounters.dateOfService,
            clientName: clients.name,
            payerName: payers.name,
            carc: workItems.reasonCode,
            amountCents: workItems.amountCents,
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
      patient:
        r.lastName && r.firstName ? patientLabel({ lastName: r.lastName, firstName: r.firstName }) : null,
      dateOfService: r.dos,
      clientName: r.clientName,
      payerName: r.payerName,
      carc: r.carc,
      kind: remit.denialKind(r.carc),
      amountCents: Number(r.amountCents ?? 0),
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
