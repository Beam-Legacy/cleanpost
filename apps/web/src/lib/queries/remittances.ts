import 'server-only';
import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  chargeLines,
  claimLines,
  claims,
  clients,
  connections,
  patients,
  payers,
  pmPostings,
  providerAdjustments,
  remitAdjustments,
  remitClaims,
  remitLines,
  remittances,
  withAudit,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';
import { patientLabel } from './work';

const NONE = '00000000-0000-0000-0000-000000000000';
const PAGE = 100;

/** R-01 status chips for Modes A and C (Posting and Posted are Mode B, M7). */
export const REMIT_VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'waiting', label: 'Waiting for PM' },
  { key: 'verified', label: 'Verified' },
] as const;
export type RemitView = (typeof REMIT_VIEWS)[number]['key'];

const ATTENTION = ['out_of_balance', 'partially_matched', 'posting_mismatch', 'post_failed'];
const WAITING = ['received', 'parsed', 'balanced', 'matched', 'verifying'];

function viewWhere(view: RemitView): SQL | undefined {
  if (view === 'attention') return inArray(remittances.status, ATTENTION);
  if (view === 'waiting') return inArray(remittances.status, WAITING);
  if (view === 'verified') return inArray(remittances.status, ['reconciled', 'posted']);
  return undefined;
}

function scope(ctx: ActiveContext): SQL | undefined {
  const s = policy.clientFilter(ctx.actor);
  return s === 'all' ? undefined : inArray(remittances.clientId, s.length ? [...s] : [NONE]);
}

export interface RemitRow {
  id: string;
  paymentDate: string;
  clientName: string;
  mode: string;
  payerName: string;
  traceNumber: string;
  method: string;
  amountCents: number;
  claims: number;
  source: string;
  status: string;
  attention: string | null;
}

export interface RemitFilters {
  view: RemitView;
  clientId: string | null;
}

/** R-01: payments newest first, with what each still needs in words. No PHI. */
export async function listRemittances(ctx: ActiveContext, f: RemitFilters) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const base = [scope(ctx), f.clientId ? eq(remittances.clientId, f.clientId) : undefined];
    const claimCount = sql<number>`(select count(*)::int from ${remitClaims} where ${remitClaims.remittanceId} = ${remittances.id})`;
    const rows = await tx
      .select({
        id: remittances.id,
        paymentDate: remittances.paymentDate,
        clientName: clients.name,
        mode: clients.defaultMode,
        // The payer's own name where the 835 matched one; else the name in the 835.
        payerName: sql<string>`coalesce(${payers.name}, ${remittances.payerName})`,
        traceNumber: remittances.traceNumber,
        method: remittances.paymentMethod,
        amountCents: remittances.paymentAmountCents,
        claims: claimCount,
        source: remittances.source,
        status: remittances.status,
      })
      .from(remittances)
      .innerJoin(clients, eq(clients.id, remittances.clientId))
      .leftJoin(payers, eq(payers.id, remittances.payerId))
      .where(and(...base, viewWhere(f.view)))
      .orderBy(desc(remittances.paymentDate), desc(remittances.createdAt))
      .limit(PAGE);
    const open = rows.length
      ? await tx
          .select({ remittanceId: workItems.remittanceId, summary: workItems.summary, type: workItems.type })
          .from(workItems)
          .where(
            and(
              inArray(
                workItems.remittanceId,
                rows.map((r) => r.id),
              ),
              ne(workItems.status, 'resolved'),
              inArray(workItems.type, [
                'out_of_balance',
                'posting_exception',
                'remit_unmatched',
                'mapping_needed',
              ]),
            ),
          )
      : [];
    const counts = await tx
      .select({ status: remittances.status, n: count() })
      .from(remittances)
      .where(and(...base))
      .groupBy(remittances.status);
    const n = (states: string[]) =>
      counts.filter((c) => states.includes(c.status)).reduce((s, c) => s + Number(c.n), 0);
    const month = new Date().toISOString().slice(0, 7);
    const [period] = await tx
      .select({
        n: count(),
        total: sql<number>`coalesce(sum(${remittances.paymentAmountCents}), 0)::bigint`,
      })
      .from(remittances)
      .where(and(...base, sql`to_char(${remittances.paymentDate}, 'YYYY-MM') = ${month}`));
    return {
      rows: rows.map((r): RemitRow => {
        const items = open.filter((o) => o.remittanceId === r.id);
        return {
          ...r,
          amountCents: Number(r.amountCents),
          attention: items.length
            ? items.length === 1
              ? items[0]!.summary
              : `${items.length} things to resolve: ${items[0]!.summary}`
            : null,
        };
      }),
      counts: {
        all: counts.reduce((s, c) => s + Number(c.n), 0),
        attention: n(ATTENTION),
        waiting: n(WAITING),
        verified: n(['reconciled', 'posted']),
      },
      month: { count: Number(period?.n ?? 0), totalCents: Number(period?.total ?? 0) },
    };
  });
}

export interface RemitLineView {
  id: string;
  claimId: string | null;
  patient: string | null;
  patientControlNumber: string | null;
  lineNumber: number;
  code: string;
  modifiers: string[];
  paidCents: number;
  adjustments: { group: string; carc: string; amountCents: number }[];
  posted: {
    paidCents: number;
    adjustments: { code: string; amountCents: number }[];
    patientRespCents: number;
  } | null;
  status: string | null;
  differences: { field: string; expected: string; actual: string }[];
}

/** R-04: one payment, its two checks, and each line against what the PM posted. */
export async function getRemittance(ctx: ActiveContext, id: string) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [r] = await tx
      .select({
        remit: remittances,
        clientName: clients.name,
        mode: clients.defaultMode,
        payer: payers.name,
      })
      .from(remittances)
      .innerJoin(clients, eq(clients.id, remittances.clientId))
      .leftJoin(payers, eq(payers.id, remittances.payerId))
      .where(and(eq(remittances.id, id), scope(ctx)));
    if (!r) return null;
    const [conn] = await tx
      .select({ settings: connections.settings })
      .from(connections)
      .where(eq(connections.clientId, r.remit.clientId))
      .limit(1);
    const pmName = ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM';
    const rcs = await tx
      .select()
      .from(remitClaims)
      .where(eq(remitClaims.remittanceId, id))
      .orderBy(asc(remitClaims.createdAt), asc(remitClaims.id));
    const matched = rcs.filter((c) => c.claimId);
    // Patient names are PHI: the read is audited (CLAUDE.md rule 7).
    const names = matched.length
      ? await withAudit(
          tx,
          {
            actor: `user:${ctx.user.id}`,
            action: 'remittance.viewed',
            entityType: 'remittance',
            entityId: id,
            clientId: r.remit.clientId,
            metadata: { claims: matched.length },
          },
          () =>
            tx
              .select({ claimId: claims.id, lastName: patients.lastName, firstName: patients.firstName })
              .from(claims)
              .innerJoin(patients, eq(patients.id, claims.patientId))
              .where(
                inArray(
                  claims.id,
                  matched.map((c) => c.claimId!),
                ),
              ),
        )
      : [];
    const lines = rcs.length
      ? await tx
          .select({
            line: remitLines,
            lineNumber: claimLines.lineNumber,
            chargeExternalId: chargeLines.externalId,
          })
          .from(remitLines)
          .leftJoin(claimLines, eq(claimLines.id, remitLines.claimLineId))
          .leftJoin(chargeLines, eq(chargeLines.id, claimLines.chargeLineId))
          .where(
            inArray(
              remitLines.remitClaimId,
              rcs.map((c) => c.id),
            ),
          )
          .orderBy(asc(remitLines.createdAt), asc(remitLines.id))
      : [];
    const adjustments = lines.length
      ? await tx
          .select()
          .from(remitAdjustments)
          .where(
            inArray(
              remitAdjustments.remitLineId,
              lines.map((l) => l.line.id),
            ),
          )
      : [];
    const posted = await tx
      .select()
      .from(pmPostings)
      .where(and(eq(pmPostings.clientId, r.remit.clientId), eq(pmPostings.traceNumber, r.remit.traceNumber)));
    const plb = await tx.select().from(providerAdjustments).where(eq(providerAdjustments.remittanceId, id));
    const items = await tx
      .select({
        id: workItems.id,
        type: workItems.type,
        claimId: workItems.claimId,
        summary: workItems.summary,
        status: workItems.status,
      })
      .from(workItems)
      .where(and(eq(workItems.remittanceId, id), ne(workItems.status, 'resolved')));

    const byClaim = new Map(rcs.map((c) => [c.id, c]));
    const lineViews: RemitLineView[] = lines.map(({ line: l, lineNumber, chargeExternalId }, i) => {
      const rc = byClaim.get(l.remitClaimId)!;
      const name = names.find((n) => n.claimId === rc.claimId);
      const key = l.lineControlNumber ?? chargeExternalId;
      const mine = key ? posted.filter((p) => p.lineExternalId === key) : [];
      return {
        id: l.id,
        claimId: rc.claimId,
        patient: name ? patientLabel(name) : null,
        patientControlNumber: rc.patientControlNumber,
        lineNumber: lineNumber ?? i + 1,
        code: l.code,
        modifiers: l.modifiers,
        paidCents: Number(l.paidCents),
        adjustments: adjustments
          .filter((a) => a.remitLineId === l.id)
          .map((a) => ({ group: a.groupCode, carc: a.carc, amountCents: Number(a.amountCents) })),
        posted: mine.length
          ? {
              paidCents: mine.reduce((s, p) => s + Number(p.paidCents), 0),
              adjustments: mine.flatMap((p) =>
                p.adjustments.map((a) => ({ code: a.pmAdjustmentCode, amountCents: a.amountCents })),
              ),
              patientRespCents: mine.reduce((s, p) => s + Number(p.patientRespCents), 0),
            }
          : null,
        status: l.verifyStatus,
        differences: l.verifyDetail ?? [],
      };
    });
    const claimsPaid = rcs.reduce((s, c) => s + Number(c.paidCents), 0);
    const plbTotal = plb.reduce((s, p) => s + Number(p.amountCents), 0);
    const tally = (s: string) => lineViews.filter((l) => l.status === s).length;
    return {
      id,
      clientId: r.remit.clientId,
      clientName: r.clientName,
      mode: r.mode,
      pmName,
      payerName: r.payer ?? r.remit.payerName,
      traceNumber: r.remit.traceNumber,
      method: r.remit.paymentMethod,
      amountCents: Number(r.remit.paymentAmountCents),
      paymentDate: r.remit.paymentDate,
      source: r.remit.source,
      status: r.remit.status,
      receivedAt: r.remit.createdAt,
      claimsPaidCents: claimsPaid,
      // PLB lines by reason (interest is often one line per claim).
      providerAdjustments: [
        ...plb
          .reduce(
            (m, p) => m.set(p.reasonCode, (m.get(p.reasonCode) ?? 0) + Number(p.amountCents)),
            new Map<string, number>(),
          )
          .entries(),
      ].map(([reasonCode, amountCents]) => ({ reasonCode, amountCents })),
      balanced:
        r.remit.status !== 'out_of_balance' && claimsPaid - plbTotal === Number(r.remit.paymentAmountCents),
      counts: {
        claims: rcs.length,
        lines: lineViews.length,
        verified: tally('verified'),
        differences: tally('mismatch') + tally('missing'),
        unmapped: tally('unmapped'),
        pending: tally('pending') + lineViews.filter((l) => l.status === null && l.claimId).length,
        unmatched: rcs.length - matched.length,
      },
      unmatched: rcs
        .filter((c) => !c.claimId)
        .map((c) => ({
          id: c.id,
          patientControlNumber: c.patientControlNumber,
          paidCents: Number(c.paidCents),
        })),
      lines: lineViews,
      items,
    };
  });
}
export type RemitDetail = NonNullable<Awaited<ReturnType<typeof getRemittance>>>;
