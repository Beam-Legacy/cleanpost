/**
 * `remit.verify` (docs/07-remittance-posting.md, docs/03 remittance machine): Modes A and C, where
 * the PM posts. After each sync reads the PM's postings, every matched remittance is checked line by
 * line (the posting match). Each line ends verified, pending (the PM has not posted the payment yet),
 * or with exactly one open work item that says why:
 * - posting_exception per claim: lines the PM posted differently or skipped;
 * - posting_exception per remittance: the PM has not posted the payment at all after the grace days;
 * - mapping_needed per client and group-CARC: an adjustment with no PM code to compare against.
 * The remittance moves verifying -> reconciled | posting_mismatch, and posting_mismatch ->
 * reconciled once every exception is resolved. Items the check opened and that verify later are
 * closed by automation; items a person resolved stay resolved.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  adjustmentMappings,
  chargeLines,
  claimLines,
  clients,
  connections,
  pmPostings,
  recordAudit,
  remitAdjustments,
  remitClaims,
  remitLines,
  remittances,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { formatCents, remit, state } from '@cleanpost/domain';
import { createWorkItem } from './items';

/** Days the PM has to post a payment before Cleanpost says it has not. */
export const POSTING_GRACE_DAYS = 3;

export interface VerifyContext {
  tenantId: string;
  clientId: string;
  actor?: AuditActor;
}

export interface VerifyOutcome {
  remittances: number;
  reconciled: number;
  mismatched: number;
  pending: number;
  lines: { verified: number; mismatch: number; missing: number; unmapped: number; pending: number };
}

type Item = typeof workItems.$inferSelect;

async function moveRemittance(tx: Tx, id: string, from: string, event: state.RemittanceEvent, now: Date) {
  const next = state.nextRemittanceState(from as state.RemittanceState, event);
  if (!next.ok) return from;
  await tx.update(remittances).set({ status: next.value, updatedAt: now }).where(eq(remittances.id, id));
  return next.value;
}

async function moveItem(tx: Tx, item: Item, event: state.WorkItemEvent, actor: AuditActor, now: Date) {
  const next = state.nextWorkItemState(item.status as state.WorkItemState, event);
  if (!next.ok) return;
  await tx
    .update(workItems)
    .set({
      status: next.value,
      updatedAt: now,
      ...(next.value === 'resolved'
        ? { resolvedBy: actor, resolvedAt: now, resolution: 'verified' }
        : { resolvedBy: null, resolvedAt: null, resolution: null }),
    })
    .where(eq(workItems.id, item.id));
  await recordAudit(tx, {
    actor,
    action: `work_item.${event}`,
    entityType: 'work_item',
    entityId: item.id,
    clientId: item.clientId,
    metadata: { type: item.type },
  });
}

/**
 * Keeps one item for a problem: opens it, refreshes its summary, reopens it if the check closed it
 * and the problem is back, or closes it when the problem is gone. A person's resolution stands.
 */
async function ensureItem(
  tx: Tx,
  existing: Item | undefined,
  want: Parameters<typeof createWorkItem>[1] | null,
  actor: AuditActor,
  now: Date,
): Promise<'open' | 'accepted' | 'none'> {
  if (!want) {
    if (existing && existing.status !== 'resolved') await moveItem(tx, existing, 'auto_resolve', actor, now);
    return existing?.status === 'resolved' && existing.resolvedBy?.startsWith('user:') ? 'accepted' : 'none';
  }
  if (!existing) {
    await createWorkItem(tx, want, actor);
    return 'open';
  }
  if (existing.status === 'resolved') {
    if (existing.resolvedBy?.startsWith('user:')) return 'accepted';
    await moveItem(tx, existing, 'reopen', actor, now);
  }
  if (existing.summary !== want.summary || existing.amountCents !== want.amountCents)
    await tx
      .update(workItems)
      .set({ summary: want.summary, amountCents: want.amountCents, updatedAt: now })
      .where(eq(workItems.id, existing.id));
  return 'open';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function verifyInTx(tx: Tx, ctx: VerifyContext, now: Date): Promise<VerifyOutcome> {
  const actor: AuditActor = ctx.actor ?? 'automation:remit.verify';
  const out: VerifyOutcome = {
    remittances: 0,
    reconciled: 0,
    mismatched: 0,
    pending: 0,
    lines: { verified: 0, mismatch: 0, missing: 0, unmapped: 0, pending: 0 },
  };
  const [client] = await tx.select().from(clients).where(eq(clients.id, ctx.clientId));
  // Mode B: Cleanpost posts and checks its own postings (M7).
  if (!client || client.defaultMode === 'B') return out;

  const pmTypes = (
    await tx
      .select({ k: connections.adapterKey })
      .from(connections)
      .where(eq(connections.clientId, ctx.clientId))
  ).map((r) => r.k);
  const mappingRows = await tx
    .select()
    .from(adjustmentMappings)
    .where(
      or(
        eq(adjustmentMappings.clientId, ctx.clientId),
        and(
          isNull(adjustmentMappings.clientId),
          pmTypes.length ? inArray(adjustmentMappings.pmType, pmTypes) : sql`false`,
        ),
      ),
    );
  const lookup = remit.mappingLookup(mappingRows, ctx.clientId);

  const due = await tx
    .select()
    .from(remittances)
    .where(
      and(
        eq(remittances.clientId, ctx.clientId),
        inArray(remittances.status, ['matched', 'verifying', 'posting_mismatch']),
      ),
    );
  const items = due.length
    ? await tx
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.clientId, ctx.clientId),
            or(
              and(
                inArray(
                  workItems.remittanceId,
                  due.map((d) => d.id),
                ),
                eq(workItems.type, 'posting_exception'),
              ),
              eq(workItems.type, 'mapping_needed'),
            ),
          ),
        )
    : [];
  const mappingItems = new Map(
    items.filter((i) => i.type === 'mapping_needed' && i.status !== 'resolved').map((i) => [i.reasonCode, i]),
  );

  for (const r of due) {
    out.remittances++;
    let status = r.status;
    if (status === 'matched') status = await moveRemittance(tx, r.id, status, 'verify', now);

    const rClaims = await tx
      .select()
      .from(remitClaims)
      .where(and(eq(remitClaims.remittanceId, r.id), eq(remitClaims.matchStatus, 'matched')));
    const claimIds = rClaims.map((c) => c.id);
    const lines = claimIds.length
      ? await tx
          .select({ line: remitLines, chargeExternalId: chargeLines.externalId })
          .from(remitLines)
          .leftJoin(claimLines, eq(claimLines.id, remitLines.claimLineId))
          .leftJoin(chargeLines, eq(chargeLines.id, claimLines.chargeLineId))
          .where(inArray(remitLines.remitClaimId, claimIds))
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
      .where(and(eq(pmPostings.clientId, ctx.clientId), eq(pmPostings.traceNumber, r.traceNumber)));

    const setLine = (id: string, status: string, detail: remit.Difference[] | null) =>
      tx
        .update(remitLines)
        .set({ verifyStatus: status, verifyDetail: detail, verifiedAt: now, updatedAt: now })
        .where(eq(remitLines.id, id));

    // Nothing posted for this payment yet: wait out the grace days, then one item for the payment.
    const late = now.getTime() - r.createdAt.getTime() > POSTING_GRACE_DAYS * 86_400_000;
    const paymentItem = items.find((i) => i.remittanceId === r.id && i.claimId === null);
    if (!posted.length && lines.length) {
      for (const l of lines) await setLine(l.line.id, late ? 'missing' : 'pending', null);
      out.lines[late ? 'missing' : 'pending'] += lines.length;
      const res = await ensureItem(
        tx,
        paymentItem,
        late
          ? {
              tenantId: ctx.tenantId,
              clientId: ctx.clientId,
              type: 'posting_exception',
              priority: 2,
              hours: 24,
              reasonCode: 'NOT_POSTED',
              summary: `PM has not posted this payment: ${formatCents(r.paymentAmountCents)}, trace ${r.traceNumber}.`,
              amountCents: r.paymentAmountCents,
              remittanceId: r.id,
              now,
            }
          : null,
        actor,
        now,
      );
      if (res === 'open') {
        if (status === 'verifying') await moveRemittance(tx, r.id, status, 'posting_mismatch', now);
        out.mismatched++;
      } else if (res === 'accepted') {
        await moveRemittance(
          tx,
          r.id,
          status,
          status === 'verifying' ? 'posting_match' : 'resolve_exceptions',
          now,
        );
        out.reconciled++;
      } else out.pending++;
      continue;
    }
    if (paymentItem) await ensureItem(tx, paymentItem, null, actor, now);

    let open = 0;
    for (const c of rClaims) {
      const bad: { field: string }[] = [];
      let badLines = 0;
      for (const { line: l, chargeExternalId } of lines.filter((x) => x.line.remitClaimId === c.id)) {
        const key = l.lineControlNumber ?? chargeExternalId;
        const payment: remit.ServiceLinePayment = {
          code: l.code,
          modifiers: l.modifiers,
          chargeCents: l.chargeCents,
          paidCents: l.paidCents,
          units: l.units,
          allowedCents: l.allowedCents,
          lineControlNumber: l.lineControlNumber,
          serviceDate: null,
          adjustments: adjustments
            .filter((a) => a.remitLineId === l.id)
            .map((a) => ({
              group: a.groupCode as remit.GroupCode,
              carc: a.carc,
              amountCents: a.amountCents,
            })),
          remarks: [],
        };
        const result = remit.verifyLine(
          payment,
          key ? posted.filter((p) => p.lineExternalId === key) : [],
          lookup,
        );
        out.lines[result.status]++;
        await setLine(l.id, result.status, result.status === 'mismatch' ? result.differences : null);
        if (result.status === 'unmapped') {
          for (const pair of result.pairs) {
            if (mappingItems.has(pair)) continue;
            await createWorkItem(
              tx,
              {
                tenantId: ctx.tenantId,
                clientId: ctx.clientId,
                type: 'mapping_needed',
                priority: 1,
                hours: 24,
                reasonCode: pair,
                summary: `No PM adjustment code for ${pair}: map it to check postings.`,
                amountCents: null,
                remittanceId: r.id,
                now,
              },
              actor,
            );
            mappingItems.set(pair, {} as Item);
          }
          open++;
        } else if (result.status === 'mismatch') {
          badLines++;
          bad.push(...result.differences);
        } else if (result.status === 'missing') {
          badLines++;
          bad.push({ field: 'Not posted' });
        }
      }
      const fields = [...new Set(bad.map((b) => b.field))];
      const res = await ensureItem(
        tx,
        items.find((i) => i.remittanceId === r.id && i.claimId === c.claimId),
        badLines
          ? {
              tenantId: ctx.tenantId,
              clientId: ctx.clientId,
              type: 'posting_exception',
              priority: 2,
              hours: 24,
              reasonCode: fields.includes('Denial written off') ? 'DENIAL_WRITTEN_OFF' : 'POSTING_DIFFERS',
              summary: `PM posting does not match the 835 on ${plural(badLines, 'line', 'lines')}: ${fields.join(', ')}.`,
              amountCents: c.paidCents,
              claimId: c.claimId,
              remittanceId: r.id,
              now,
            }
          : null,
        actor,
        now,
      );
      if (res === 'open') open++;
    }
    if (open) {
      if (status === 'verifying') await moveRemittance(tx, r.id, status, 'posting_mismatch', now);
      out.mismatched++;
    } else {
      await moveRemittance(
        tx,
        r.id,
        status,
        status === 'verifying' ? 'posting_match' : 'resolve_exceptions',
        now,
      );
      out.reconciled++;
    }
  }
  if (out.remittances)
    await recordAudit(tx, {
      actor,
      action: 'remittance.verified',
      entityType: 'client',
      entityId: ctx.clientId,
      clientId: ctx.clientId,
      metadata: { ...out.lines, reconciled: out.reconciled, mismatched: out.mismatched },
    });
  return out;
}
