/**
 * W-19 Map an adjustment code (docs/07 "Adjustment mapping"): a group code and CARC from an 835 to the
 * PM's own adjustment code and what it does. A mapping applies to every client on that PM type
 * (tenant default) or to one client (override). Saving it closes the `mapping_needed` items it
 * answers and runs the posting match again, so lines held for the mapping are checked at once.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  adjustmentMappings,
  connections,
  recordAudit,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import { z } from 'zod';
import { verifyInTx } from './verify';
import { now as clockNow } from '@cleanpost/clock';

export const mappingInputSchema = z.object({
  /** The client the item came from: its PM type is the one mapped. */
  clientId: z.uuid(),
  groupCode: z.enum(['CO', 'PR', 'OA', 'PI', 'CR']),
  carc: z.string().regex(/^[A-Z0-9]{1,5}$/),
  pmAdjustmentCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_.-]+$/, 'Letters, numbers, dot, dash or underscore'),
  action: z.enum(['adjust', 'transfer_to_patient', 'write_off', 'info_only']),
  /** pm_type: every client on this PM type; client: this client only. */
  scope: z.enum(['pm_type', 'client']),
});
export type MappingInput = z.infer<typeof mappingInputSchema>;

export type MappingOutcome =
  | { ok: true; pmType: string; itemsClosed: number; clientsChecked: number }
  | { ok: false; reason: 'no_connection' };

export async function saveMapping(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: MappingInput,
  now = clockNow(),
): Promise<MappingOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const [conn] = await tx
    .select({ adapterKey: connections.adapterKey })
    .from(connections)
    .where(eq(connections.clientId, input.clientId))
    .limit(1);
  if (!conn) return { ok: false, reason: 'no_connection' };
  const pmType = conn.adapterKey;
  const clientId = input.scope === 'client' ? input.clientId : null;
  const values = {
    tenantId: ctx.tenantId,
    clientId,
    pmType,
    groupCode: input.groupCode,
    carc: input.carc,
    pmAdjustmentCode: input.pmAdjustmentCode.toUpperCase(),
    action: input.action,
  };
  const [row] = await tx
    .insert(adjustmentMappings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        adjustmentMappings.tenantId,
        adjustmentMappings.clientId,
        adjustmentMappings.pmType,
        adjustmentMappings.groupCode,
        adjustmentMappings.carc,
      ],
      set: { pmAdjustmentCode: values.pmAdjustmentCode, action: values.action, updatedAt: now },
    })
    .returning({ id: adjustmentMappings.id });
  await recordAudit(tx, {
    actor,
    action: 'adjustment_mapping.saved',
    entityType: 'adjustment_mapping',
    entityId: row!.id,
    clientId: input.clientId,
    metadata: { pmType, scope: input.scope, pair: `${input.groupCode}-${input.carc}`, action: input.action },
  });

  // The clients this answers: the one client, or every client on the PM type.
  const clientIds =
    input.scope === 'client'
      ? [input.clientId]
      : (
          await tx
            .selectDistinct({ clientId: connections.clientId })
            .from(connections)
            .where(eq(connections.adapterKey, pmType))
        ).map((r) => r.clientId);
  const open = await tx
    .select()
    .from(workItems)
    .where(
      and(
        inArray(workItems.clientId, clientIds),
        eq(workItems.type, 'mapping_needed'),
        eq(workItems.reasonCode, `${input.groupCode}-${input.carc}`),
        ne(workItems.status, 'resolved'),
      ),
    );
  for (const item of open) {
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({ status: next.value, resolvedBy: actor, resolvedAt: now, resolution: 'Mapped', updatedAt: now })
      .where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor,
      action: 'work_item.resolve',
      entityType: 'work_item',
      entityId: item.id,
      clientId: item.clientId,
      metadata: { type: item.type, reason: 'Mapped' },
    });
  }
  for (const c of clientIds) await verifyInTx(tx, { tenantId: ctx.tenantId, clientId: c, actor }, now);
  return { ok: true, pmType, itemsClosed: open.length, clientsChecked: clientIds.length };
}
