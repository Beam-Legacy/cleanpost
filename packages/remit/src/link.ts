/**
 * W-17 Unmatched payment (docs/07 "Matching"): a person links a payment in an 835 to the right claim,
 * or sets it aside (billed before the client went live on Cleanpost, or not this client's). When no
 * payment in the remittance is left unmatched, it moves on to the posting match.
 */
import { and, asc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import {
  claimLines,
  claims,
  recordAudit,
  remitAdjustments,
  remitClaims,
  remitLines,
  remitRemarks,
  remittances,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { state, type remit } from '@cleanpost/domain';
import { applyMatch } from './ingest';
import { verifyInTx } from './verify';
import { now as clockNow } from '@cleanpost/clock';

export const SET_ASIDE_REASONS = ['Before go-live', 'Not ours'] as const;
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];

type Refusal = 'not_found' | 'not_unmatched' | 'claim_not_found';
export type LinkOutcome = { ok: true; remittanceStatus: string } | { ok: false; reason: Refusal };

async function openItem(tx: Tx, itemId: string, lock = true) {
  const itemQ = tx.select().from(workItems).where(eq(workItems.id, itemId));
  const [item] = lock ? await itemQ.for('update') : await itemQ;
  if (!item || item.type !== 'remit_unmatched' || !item.remitClaimId) return null;
  const rcQ = tx.select().from(remitClaims).where(eq(remitClaims.id, item.remitClaimId));
  const [rc] = lock ? await rcQ.for('update') : await rcQ;
  return rc ? { item, rc } : null;
}

/** The 835 claim payment as stored, in the canonical shape. */
export async function storedPayment(tx: Tx, rc: typeof remitClaims.$inferSelect) {
  const lines = await tx
    .select()
    .from(remitLines)
    .where(eq(remitLines.remitClaimId, rc.id))
    .orderBy(asc(remitLines.createdAt), asc(remitLines.id));
  const ids = lines.map((l) => l.id);
  const adj = ids.length
    ? await tx.select().from(remitAdjustments).where(inArray(remitAdjustments.remitLineId, ids))
    : [];
  const claimAdj = await tx.select().from(remitAdjustments).where(eq(remitAdjustments.remitClaimId, rc.id));
  const remarks = ids.length
    ? await tx.select().from(remitRemarks).where(inArray(remitRemarks.remitLineId, ids))
    : [];
  const toAdj = (a: typeof remitAdjustments.$inferSelect): remit.Adjustment => ({
    group: a.groupCode as remit.GroupCode,
    carc: a.carc,
    amountCents: Number(a.amountCents),
    ...(a.quantity !== null ? { quantity: a.quantity } : {}),
  });
  const payment: remit.ClaimPayment = {
    patientControlNumber: rc.patientControlNumber ?? '',
    statusCode: rc.claimStatusCode,
    chargeCents: Number(rc.chargeCents),
    paidCents: Number(rc.paidCents),
    patientRespCents: Number(rc.patientRespCents),
    payerClaimControlNumber: rc.payerClaimControlNumber,
    frequencyCode: null,
    patient: null,
    serviceDateFrom: null,
    adjustments: claimAdj.map(toAdj),
    remarks: [],
    crossoverPayerName: null,
    lines: lines.map((l) => ({
      code: l.code,
      modifiers: l.modifiers,
      chargeCents: Number(l.chargeCents),
      paidCents: Number(l.paidCents),
      units: l.units,
      allowedCents: l.allowedCents === null ? null : Number(l.allowedCents),
      lineControlNumber: l.lineControlNumber,
      serviceDate: null,
      adjustments: adj.filter((a) => a.remitLineId === l.id).map(toAdj),
      remarks: remarks.filter((r) => r.remitLineId === l.id).map((r) => r.rarc),
    })),
  };
  return { payment, lineIds: ids };
}

async function closeItem(
  tx: Tx,
  item: typeof workItems.$inferSelect,
  reason: string,
  actor: AuditActor,
  now: Date,
) {
  const next = state.nextWorkItemState(item.status as state.WorkItemState, 'resolve');
  if (!next.ok) return;
  await tx
    .update(workItems)
    .set({ status: next.value, resolvedBy: actor, resolvedAt: now, resolution: reason, updatedAt: now })
    .where(eq(workItems.id, item.id));
  await recordAudit(tx, {
    actor,
    action: 'work_item.resolve',
    entityType: 'work_item',
    entityId: item.id,
    clientId: item.clientId,
    metadata: { type: item.type, reason },
  });
}

/** Once nothing in the remittance is unmatched, it goes on to the posting match. */
async function finishMatching(tx: Tx, remittanceId: string, tenantId: string, actor: AuditActor, now: Date) {
  const [r] = await tx.select().from(remittances).where(eq(remittances.id, remittanceId)).for('update');
  if (!r) return 'missing';
  const left = await tx
    .select({ id: remitClaims.id })
    .from(remitClaims)
    .where(and(eq(remitClaims.remittanceId, remittanceId), eq(remitClaims.matchStatus, 'unmatched')));
  if (left.length || r.status !== 'partially_matched') return r.status;
  const next = state.nextRemittanceState('partially_matched', 'resolve_unmatched');
  if (!next.ok) return r.status;
  await tx.update(remittances).set({ status: next.value, updatedAt: now }).where(eq(remittances.id, r.id));
  await verifyInTx(tx, { tenantId, clientId: r.clientId, actor }, now);
  const [after] = await tx
    .select({ status: remittances.status })
    .from(remittances)
    .where(eq(remittances.id, r.id));
  return after!.status;
}

export async function linkPayment(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: { itemId: string; claimId: string },
  now = clockNow(),
): Promise<LinkOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const found = await openItem(tx, input.itemId);
  if (!found) return { ok: false, reason: 'not_found' };
  const { item, rc } = found;
  if (rc.matchStatus !== 'unmatched' || item.status === 'resolved')
    return { ok: false, reason: 'not_unmatched' };
  const [claim] = await tx
    .select()
    .from(claims)
    .where(and(eq(claims.id, input.claimId), eq(claims.clientId, rc.clientId)))
    .for('update');
  if (!claim) return { ok: false, reason: 'claim_not_found' };
  const [r] = await tx.select().from(remittances).where(eq(remittances.id, rc.remittanceId));
  const { payment, lineIds } = await storedPayment(tx, rc);
  await applyMatch(tx, {
    tenantId: ctx.tenantId,
    clientId: rc.clientId,
    remittanceId: rc.remittanceId,
    traceNumber: r!.traceNumber,
    remitClaimId: rc.id,
    lineIds,
    payment,
    claim,
    by: 'manual',
    actor,
    now,
  });
  await recordAudit(tx, {
    actor,
    action: 'remittance.payment_linked',
    entityType: 'remittance',
    entityId: rc.remittanceId,
    clientId: rc.clientId,
    metadata: { remitClaimId: rc.id, claimId: claim.id },
  });
  await closeItem(tx, item, 'Linked by hand', actor, now);
  return { ok: true, remittanceStatus: await finishMatching(tx, rc.remittanceId, ctx.tenantId, actor, now) };
}

export async function setAsidePayment(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: { itemId: string; reason: SetAsideReason },
  now = clockNow(),
): Promise<LinkOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const found = await openItem(tx, input.itemId);
  if (!found) return { ok: false, reason: 'not_found' };
  const { item, rc } = found;
  if (rc.matchStatus !== 'unmatched' || item.status === 'resolved')
    return { ok: false, reason: 'not_unmatched' };
  await tx
    .update(remitClaims)
    .set({ matchStatus: 'set_aside', matchedBy: 'manual', updatedAt: now })
    .where(eq(remitClaims.id, rc.id));
  await recordAudit(tx, {
    actor,
    action: 'remittance.payment_set_aside',
    entityType: 'remittance',
    entityId: rc.remittanceId,
    clientId: rc.clientId,
    metadata: { remitClaimId: rc.id, reason: input.reason },
  });
  await closeItem(tx, item, input.reason, actor, now);
  return { ok: true, remittanceStatus: await finishMatching(tx, rc.remittanceId, ctx.tenantId, actor, now) };
}

export interface LinkCandidate {
  claimId: string;
  status: string;
  patientControlNumber: string | null;
  totalChargeCents: number;
  /** Every code in the payment is on the claim. */
  codesMatch: boolean;
}

/** Claims of the same client that could be this payment: same total charge, codes compared. */
export async function linkCandidates(tx: Tx, itemId: string): Promise<LinkCandidate[]> {
  const found = await openItem(tx, itemId, false);
  if (!found) return [];
  const { rc } = found;
  const rows = await tx
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.clientId, rc.clientId),
        eq(claims.totalChargeCents, Math.abs(Number(rc.chargeCents))),
        notInArray(claims.status, ['voided', 'closed']),
        ne(claims.status, 'draft'),
      ),
    )
    .limit(20);
  const paidCodes = (
    await tx.select({ code: remitLines.code }).from(remitLines).where(eq(remitLines.remitClaimId, rc.id))
  ).map((l) => l.code);
  const out: LinkCandidate[] = [];
  for (const c of rows) {
    const codes = c.currentVersionId
      ? (
          await tx
            .select({ code: claimLines.code })
            .from(claimLines)
            .where(eq(claimLines.claimVersionId, c.currentVersionId))
        ).map((l) => l.code)
      : [];
    out.push({
      claimId: c.id,
      status: c.status,
      patientControlNumber: c.patientControlNumber,
      totalChargeCents: Number(c.totalChargeCents),
      codesMatch: paidCodes.every((p) => codes.includes(p)),
    });
  }
  return out.sort((a, b) => Number(b.codesMatch) - Number(a.codesMatch)).slice(0, 5);
}
