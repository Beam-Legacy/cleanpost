/**
 * Applies the PM's claim status (pullClaimsAndStatus, docs/04-modes.md Mode A) to Cleanpost claims:
 * the patient control number the PM's clearinghouse assigned, then 277CA accept or reject. A reject
 * opens a `rejection` work item (docs/08). Paid and denied come from 835s in M3.
 *
 * Used by packages/sync as the applier for pullClaimsAndStatus, inside the page's tenant transaction.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ExtClaimStatus } from '@cleanpost/adapters';
import {
  claims,
  claimVersions,
  externalRefs,
  recordAudit,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import { applyClaimEvent } from './events';
import { resolveAnsweredDenials } from './correct';
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

/** Claim states a PM can bill from without Cleanpost (state machine: release or billed_outside). */
const OUTSIDE_FROM = new Set(['built', 'needs_review', 'blocked', 'on_hold', 'ready']);

/** Review and blocked items for a claim that has left are moot: closed by automation. */
async function closeReviewItems(
  tx: Tx,
  claim: { id: string; clientId: string },
  actor: AuditActor,
  now: Date,
) {
  const open = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claim.id),
        inArray(workItems.type, ['claim_review', 'claim_blocked']),
        ne(workItems.status, 'resolved'),
      ),
    );
  for (const item of open) {
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({
        status: next.value,
        resolvedBy: actor,
        resolvedAt: now,
        resolution: 'Billed in the PM before review',
        updatedAt: now,
      })
      .where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor,
      action: 'work_item.auto_resolve',
      entityType: 'work_item',
      entityId: item.id,
      clientId: claim.clientId,
      metadata: { type: item.type, claimId: claim.id },
    });
  }
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
    // The claim left without Cleanpost's release: a biller approved the charge in the PM directly,
    // or a PM with no hold billed it at its batch time while Cleanpost still had it in review.
    // A corrected claim (frequency 7) left only once the PM shows it sent again; the old claim's
    // denial or payment still on the PM's record does not count.
    const [version] = current.currentVersionId
      ? await tx
          .select({ frequencyCode: claimVersions.frequencyCode, createdAt: claimVersions.createdAt })
          .from(claimVersions)
          .where(eq(claimVersions.id, current.currentVersionId))
      : [];
    const resent =
      version?.frequencyCode !== '7' ||
      ['sent', 'accepted', 'rejected'].includes(item.status) ||
      new Date(item.updatedAt) > version.createdAt;
    if (
      OUTSIDE_FROM.has(current.status) &&
      current.currentVersionId &&
      item.status !== 'unknown' &&
      item.status !== 'queued' &&
      resent
    ) {
      await markReleased(tx, current, 'pm_outside_cleanpost', ctx.actor, now);
      await closeReviewItems(tx, current, ctx.actor, now);
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
      // Flow 5: the denial a corrected claim answers closes when the payer accepts it.
      await resolveAnsweredDenials(tx, current, 'Corrected claim accepted', ctx.actor, now);
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
