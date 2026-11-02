/**
 * Closing what a denial left open once it is answered (Flow 5, D-03): the denial items when the
 * corrected claim is accepted or paid, or when the balance is written off; and any write-off request
 * still waiting for an admin, which the answer makes moot. Every change goes through the state
 * machines with the actor recorded.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  claimVersions,
  recordAudit,
  workItems,
  writeOffRequests,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';

/** Open items a corrected claim or a write-off answers: they close, and pending requests cancel. */
export async function resolveAnsweredDenials(
  tx: Tx,
  claim: { id: string; clientId: string; currentVersionId: string | null },
  why: 'Corrected claim accepted' | 'Written off',
  actor: AuditActor,
  now: Date,
): Promise<number> {
  if (why === 'Corrected claim accepted') {
    const [v] = claim.currentVersionId
      ? await tx
          .select({ f: claimVersions.frequencyCode })
          .from(claimVersions)
          .where(eq(claimVersions.id, claim.currentVersionId))
      : [];
    if (v?.f !== '7') return 0;
  }
  const open = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claim.id),
        inArray(workItems.type, why === 'Written off' ? ['denial', 'underpayment'] : ['denial']),
        ne(workItems.status, 'resolved'),
      ),
    );
  for (const item of open) await autoResolve(tx, item, why, actor, now);
  await cancelPendingWriteOffs(tx, claim, actor, now);
  return open.length;
}

/** A work item closes by itself (actor automation, or the person whose action answered it). */
export async function autoResolve(
  tx: Tx,
  item: { id: string; status: string; type: string; clientId: string | null },
  why: string,
  actor: AuditActor,
  now: Date,
): Promise<boolean> {
  const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
  if (!next.ok) return false;
  await tx
    .update(workItems)
    .set({ status: next.value, resolvedBy: actor, resolvedAt: now, resolution: why, updatedAt: now })
    .where(eq(workItems.id, item.id));
  await recordAudit(tx, {
    actor,
    action: 'work_item.auto_resolve',
    entityType: 'work_item',
    entityId: item.id,
    clientId: item.clientId,
    metadata: { type: item.type, reason: why },
  });
  return true;
}

/** Write-off requests on the claim still waiting for an admin are cancelled, with their items. */
export async function cancelPendingWriteOffs(
  tx: Tx,
  claim: { id: string; clientId: string },
  actor: AuditActor,
  now: Date,
): Promise<number> {
  const pending = await tx
    .select()
    .from(writeOffRequests)
    .where(and(eq(writeOffRequests.claimId, claim.id), eq(writeOffRequests.status, 'pending')))
    .for('update');
  for (const r of pending) {
    const next = state.nextWriteOffRequestState('pending', 'cancel');
    if (!next.ok) continue;
    await tx
      .update(writeOffRequests)
      .set({ status: next.value, decidedBy: actor, decidedAt: now, updatedAt: now })
      .where(eq(writeOffRequests.id, r.id));
    await recordAudit(tx, {
      actor,
      action: 'write_off_request.cancelled',
      entityType: 'write_off_request',
      entityId: r.id,
      clientId: claim.clientId,
      metadata: { claimId: claim.id },
    });
    if (r.approvalItemId) {
      const [item] = await tx.select().from(workItems).where(eq(workItems.id, r.approvalItemId));
      if (item && item.status !== 'resolved') await autoResolve(tx, item, 'No longer needed', actor, now);
    }
  }
  return pending.length;
}
