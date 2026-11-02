/** Manual tasks for PM operations Cleanpost cannot do itself (docs/05-adapters.md level 0). */
import { and, eq, ne } from 'drizzle-orm';
import type { Connection, OpResult } from '@cleanpost/adapters';
import type { claims } from '@cleanpost/db';
import { manualTasks, recordAudit, workItems, type AuditActor, type Tx } from '@cleanpost/db';
import { state } from '@cleanpost/domain';

export const CORRECTION_OPERATION = 'pushChargeCorrection';

/** One open manual task (and work item) per claim and operation; reused if it already exists. */
export async function ensureManualTask(
  tx: Tx,
  claim: Pick<
    typeof claims.$inferSelect,
    'id' | 'tenantId' | 'clientId' | 'encounterId' | 'totalChargeCents'
  >,
  conn: Connection,
  spec: NonNullable<Extract<OpResult, { ok: false }>['manualTask']>,
  actor: AuditActor,
  now: Date,
): Promise<string> {
  const [existing] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claim.id),
        eq(workItems.type, 'manual_task'),
        eq(workItems.reasonCode, spec.operation),
        ne(workItems.status, 'resolved'),
      ),
    );
  if (existing) return existing.id;
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      type: 'manual_task',
      priority: 2,
      dueAt: new Date(now.getTime() + 24 * 3_600_000),
      claimId: claim.id,
      encounterId: claim.encounterId,
      connectionId: conn.id,
      reasonCode: spec.operation,
      summary: spec.title,
      amountCents: claim.totalChargeCents,
    })
    .returning({ id: workItems.id });
  await tx.insert(manualTasks).values({
    tenantId: claim.tenantId,
    clientId: claim.clientId,
    connectionId: conn.id,
    operation: spec.operation,
    workItemId: item!.id,
    title: spec.title,
    instructions: spec.instructions,
  });
  await recordAudit(tx, {
    actor,
    action: 'manual_task.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: claim.clientId,
    metadata: { operation: spec.operation, claimId: claim.id },
  });
  return item!.id;
}

/** Open correction tasks for a claim: while one is open the PM may still bill the old charge. */
export async function openCorrectionTasks(tx: Tx, claimId: string) {
  return tx
    .select({ id: workItems.id, status: workItems.status })
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claimId),
        eq(workItems.type, 'manual_task'),
        eq(workItems.reasonCode, CORRECTION_OPERATION),
        ne(workItems.status, 'resolved'),
      ),
    );
}

/**
 * The PM now holds a different charge than before (it was corrected there, or changed for another
 * reason): the correction tasks are done. Recorded as automation (docs/08 "Auto-resolution").
 */
export async function resolveCorrectionTasks(tx: Tx, claimId: string, actor: AuditActor, now: Date) {
  const open = await openCorrectionTasks(tx, claimId);
  for (const item of open) {
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({
        status: next.value,
        resolvedBy: actor,
        resolution: 'PM updated',
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(workItems.id, item.id));
    await tx
      .update(manualTasks)
      .set({ status: 'done', updatedAt: now })
      .where(and(eq(manualTasks.workItemId, item.id), eq(manualTasks.status, 'open')));
    await recordAudit(tx, {
      actor,
      action: 'work_item.auto_resolved',
      entityType: 'work_item',
      entityId: item.id,
      metadata: { claimId, operation: CORRECTION_OPERATION },
    });
  }
  return open.length;
}
