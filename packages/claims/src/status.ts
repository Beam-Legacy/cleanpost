/**
 * Applies the PM's claim status (pullClaimsAndStatus, docs/04-modes.md Mode A) to Cleanpost claims:
 * the patient control number the PM's clearinghouse assigned, then 277CA accept or reject. A reject
 * opens a `rejection` work item (docs/08). Paid and denied come from 835s in M3.
 *
 * Used by packages/sync as the applier for pullClaimsAndStatus, inside the page's tenant transaction.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ExtClaimStatus } from '@cleanpost/adapters';
import { claims, externalRefs, recordAudit, workItems, type AuditActor, type Tx } from '@cleanpost/db';
import { applyClaimEvent } from './events';
import { markReleased } from './release';

export interface StatusContext {
  tenantId: string;
  clientId: string;
  connectionId: string;
  actor: AuditActor;
}

export interface StatusCounts {
  new: number;
  changed: number;
  unchanged: number;
  failed: number;
}

export async function applyClaimStatuses(
  tx: Tx,
  ctx: StatusContext,
  items: ExtClaimStatus[],
): Promise<StatusCounts> {
  const counts: StatusCounts = { new: 0, changed: 0, unchanged: 0, failed: 0 };
  if (items.length === 0) return counts;
  const refs = await tx
    .select({ externalId: externalRefs.externalId, encounterId: externalRefs.entityId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connectionId, ctx.connectionId),
        eq(externalRefs.entityType, 'encounter'),
        inArray(
          externalRefs.externalId,
          items.map((i) => i.encounterExternalId),
        ),
      ),
    );
  const encounterOf = new Map(refs.map((r) => [r.externalId, r.encounterId]));
  const now = new Date();
  for (const item of items) {
    const encounterId = encounterOf.get(item.encounterExternalId);
    const [claim] = encounterId
      ? await tx.select().from(claims).where(eq(claims.encounterId, encounterId)).for('update')
      : [];
    // Claims the PM sent before Cleanpost saw the charge have no Cleanpost claim (DEC-12).
    if (!claim) {
      counts.unchanged++;
      continue;
    }
    let changed = false;
    let current = claim;
    if (claim.pcnSource === 'pm' && !claim.patientControlNumber && item.patientControlNumber) {
      await tx
        .update(claims)
        .set({ patientControlNumber: item.patientControlNumber, updatedAt: now })
        .where(eq(claims.id, claim.id));
      changed = true;
    }
    // A biller approved the charge in the PM directly: the claim left without Cleanpost's release.
    if (current.status === 'ready' && item.status !== 'unknown') {
      await markReleased(tx, current, 'pm_outside_cleanpost', ctx.actor, now);
      current = { ...current, status: 'submitted' };
      changed = true;
    }
    if (
      current.status === 'submitted' &&
      (item.status === 'accepted' || item.status === 'paid' || item.status === 'denied')
    ) {
      await applyClaimEvent(tx, current, 'accept', {
        actor: ctx.actor,
        versionId: current.currentVersionId,
        payload: { source: 'pm' },
        now,
      });
      changed = true;
    } else if (current.status === 'submitted' && item.status === 'rejected') {
      await applyClaimEvent(tx, current, 'reject', {
        actor: ctx.actor,
        versionId: current.currentVersionId,
        payload: { source: 'pm', reasons: item.rejectionReasons ?? [] },
        now,
      });
      const [open] = await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(
          and(
            eq(workItems.claimId, claim.id),
            eq(workItems.type, 'rejection'),
            ne(workItems.status, 'resolved'),
          ),
        );
      if (!open) {
        const reason = item.rejectionReasons?.[0] ?? 'The payer rejected the claim.';
        const [wi] = await tx
          .insert(workItems)
          .values({
            tenantId: ctx.tenantId,
            clientId: ctx.clientId,
            type: 'rejection',
            priority: 1,
            dueAt: new Date(now.getTime() + 24 * 3_600_000),
            claimId: claim.id,
            encounterId: claim.encounterId,
            reasonCode: 'rejected_277ca',
            summary: `Rejected: ${reason}`.slice(0, 300),
            amountCents: claim.totalChargeCents,
          })
          .returning({ id: workItems.id });
        await recordAudit(tx, {
          actor: ctx.actor,
          action: 'work_item.created',
          entityType: 'work_item',
          entityId: wi!.id,
          clientId: ctx.clientId,
          metadata: { type: 'rejection', claimId: claim.id },
        });
      }
      changed = true;
    }
    if (changed) counts.changed++;
    else counts.unchanged++;
  }
  return counts;
}
