/** Work items the remittance steps open (docs/08-work-queue.md), each with an audit event. */
import { recordAudit, workItems, type AuditActor, type Tx } from '@cleanpost/db';

export interface NewWorkItem {
  tenantId: string;
  clientId: string;
  type: string;
  priority: 1 | 2 | 3;
  hours: number;
  reasonCode: string;
  summary: string;
  amountCents: number | null;
  claimId?: string | null;
  remittanceId: string;
  remitClaimId?: string | null;
  connectionId?: string | null;
  now: Date;
}

export async function createWorkItem(tx: Tx, v: NewWorkItem, actor: AuditActor): Promise<string> {
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: v.tenantId,
      clientId: v.clientId,
      type: v.type,
      priority: v.priority,
      dueAt: new Date(v.now.getTime() + v.hours * 3_600_000),
      claimId: v.claimId ?? null,
      remittanceId: v.remittanceId,
      remitClaimId: v.remitClaimId ?? null,
      connectionId: v.connectionId ?? null,
      reasonCode: v.reasonCode,
      summary: v.summary,
      amountCents: v.amountCents,
    })
    .returning({ id: workItems.id });
  await recordAudit(tx, {
    actor,
    action: 'work_item.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: v.clientId,
    metadata: { type: v.type, remittanceId: v.remittanceId, ...(v.claimId ? { claimId: v.claimId } : {}) },
  });
  return item!.id;
}

/** The claim this payment belongs to: our control number first, then the payer's claim number. */
