/**
 * W-18 / R-06 Accept the difference (docs/07 "835 balance"): an admin decides to go on with an 835
 * that does not add up. The reason is required and audited. The remittance moves out_of_balance ->
 * balanced; the claims that balance on their own are matched and checked against the PM as usual;
 * the ones that do not are set aside, so nothing that does not add up reaches a claim.
 */
import { and, eq, ne } from 'drizzle-orm';
import { recordAudit, remitClaims, remittances, workItems, type AuditActor, type Tx } from '@cleanpost/db';
import { remit, state } from '@cleanpost/domain';
import { applyMatch, matchClaim } from './ingest';
import { createWorkItem } from './items';
import { storedPayment } from './link';
import { verifyInTx } from './verify';

export type AcceptOutcome =
  | { ok: true; matched: number; unmatched: number; setAside: number; remittanceStatus: string }
  | { ok: false; reason: 'not_found' | 'not_out_of_balance' };

export async function acceptDifference(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: { remittanceId: string; reason: string },
  now = new Date(),
): Promise<AcceptOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const [r] = await tx.select().from(remittances).where(eq(remittances.id, input.remittanceId)).for('update');
  if (!r) return { ok: false, reason: 'not_found' };
  const accepted = state.nextRemittanceState(r.status as state.RemittanceState, 'accept_difference');
  if (!accepted.ok) return { ok: false, reason: 'not_out_of_balance' };
  await tx
    .update(remittances)
    .set({ status: accepted.value, updatedAt: now })
    .where(eq(remittances.id, r.id));
  await recordAudit(tx, {
    actor,
    action: 'remittance.difference_accepted',
    entityType: 'remittance',
    entityId: r.id,
    clientId: r.clientId,
    metadata: { reason: input.reason.slice(0, 300) },
  });

  let matched = 0;
  let unmatched = 0;
  let setAside = 0;
  const stored = await tx.select().from(remitClaims).where(eq(remitClaims.remittanceId, r.id));
  for (const rc of stored) {
    const { payment, lineIds } = await storedPayment(tx, rc);
    if (remit.claimDifference(payment) !== 0) {
      setAside++;
      await tx
        .update(remitClaims)
        .set({ matchStatus: 'set_aside', updatedAt: now })
        .where(eq(remitClaims.id, rc.id));
      continue;
    }
    const m = await matchClaim(tx, r.clientId, payment);
    if (!m) {
      unmatched++;
      await tx
        .update(remitClaims)
        .set({ matchStatus: 'unmatched', updatedAt: now })
        .where(eq(remitClaims.id, rc.id));
      await createWorkItem(
        tx,
        {
          tenantId: ctx.tenantId,
          clientId: r.clientId,
          type: 'remit_unmatched',
          priority: 2,
          hours: 24,
          reasonCode: 'NO_MATCH',
          summary: `Payment for control number ${payment.patientControlNumber} matches no claim.`,
          amountCents: payment.paidCents,
          remittanceId: r.id,
          remitClaimId: rc.id,
          now,
        },
        actor,
      );
      continue;
    }
    matched++;
    await applyMatch(tx, {
      tenantId: ctx.tenantId,
      clientId: r.clientId,
      remittanceId: r.id,
      traceNumber: r.traceNumber,
      remitClaimId: rc.id,
      lineIds,
      payment,
      claim: m.claim,
      by: m.by,
      actor,
      now,
    });
  }
  const next = state.nextRemittanceState('balanced', unmatched ? 'match_some' : 'match_all');
  if (next.ok)
    await tx.update(remittances).set({ status: next.value, updatedAt: now }).where(eq(remittances.id, r.id));

  // The out-of-balance item is answered.
  const open = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.remittanceId, r.id),
        eq(workItems.type, 'out_of_balance'),
        ne(workItems.status, 'resolved'),
      ),
    );
  for (const item of open) {
    const done = state.nextWorkItemState(item.status as state.WorkItemState, 'resolve');
    if (!done.ok) continue;
    await tx
      .update(workItems)
      .set({
        status: done.value,
        resolvedBy: actor,
        resolvedAt: now,
        resolution: 'Difference accepted',
        updatedAt: now,
      })
      .where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor,
      action: 'work_item.resolve',
      entityType: 'work_item',
      entityId: item.id,
      clientId: item.clientId,
      metadata: { type: item.type, reason: 'Difference accepted' },
    });
  }
  if (!unmatched) await verifyInTx(tx, { tenantId: ctx.tenantId, clientId: r.clientId, actor }, now);
  const [after] = await tx
    .select({ status: remittances.status })
    .from(remittances)
    .where(eq(remittances.id, r.id));
  return { ok: true, matched, unmatched, setAside, remittanceStatus: after!.status };
}
