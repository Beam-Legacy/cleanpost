/**
 * Denial to corrected claim (Flow 5; C-09, W-16, D-02).
 *
 * A corrected claim replaces an adjudicated one (CLAUDE.md rule 4): a new version with frequency 7
 * and the payer's claim control number as the original reference, scrubbed like any other version.
 * In Mode A the PM sends it: none of the PMs Cleanpost reaches today take a replacement claim
 * through their API, so release prepares a task to resubmit it from the PM, and the claim moves on
 * when the PM shows it sent again. The denial item closes itself when the corrected claim is
 * accepted. Write-off (C-14, D-03) is in write-off.ts.
 */
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import {
  claimEvents,
  claims,
  claimVersions,
  corrections,
  manualTasks,
  recordAudit,
  remitClaims,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
  withTenant,
} from '@cleanpost/db';
import { applyFix, diffPayload, state, type ClaimPayload, type SuggestedFix } from '@cleanpost/domain';
import { applyClaimEvent } from './events';
import { insertVersion } from './versions';
import { now as clockNow } from '@cleanpost/clock';

export type CorrectionRefusal =
  | 'not_found'
  | 'not_denied'
  | 'no_payer_claim_number'
  | 'in_flight'
  | 'no_change'
  | 'needs_editor'
  | 'no_matching_line';

export type BuildCorrectionOutcome =
  | { status: 'built'; versionId: string; version: number; originalRef: string; fixed: boolean }
  | { status: 'refused'; reason: CorrectionRefusal };

/** The payer's claim number for the claim: from its latest payment that was not a reversal. */
export async function payerClaimNumber(tx: Tx, claimId: string): Promise<string | null> {
  const [rc] = await tx
    .select({ ref: remitClaims.payerClaimControlNumber })
    .from(remitClaims)
    .where(
      and(
        eq(remitClaims.claimId, claimId),
        isNotNull(remitClaims.payerClaimControlNumber),
        ne(remitClaims.claimStatusCode, '22'),
      ),
    )
    .orderBy(desc(remitClaims.createdAt))
    .limit(1);
  return rc?.ref ?? null;
}

/**
 * Build the corrected claim: frequency 7 and the payer's claim number, with the suggested fix applied
 * when one is given (otherwise the person edits it in C-09). denied | partially_paid -> corrected ->
 * built, so it is scrubbed before anyone can release it.
 */
export async function buildCorrection(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; workItemId?: string },
  input: { fix?: { fix: SuggestedFix; lineNumbers: number[] } },
  now = clockNow(),
): Promise<BuildCorrectionOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim?.currentVersionId) return { status: 'refused', reason: 'not_found' };
    const from = claim.status as state.ClaimState;
    if (!state.nextClaimState(from, 'correct').ok) {
      const [current] = await tx
        .select()
        .from(claimVersions)
        .where(eq(claimVersions.id, claim.currentVersionId));
      return {
        status: 'refused',
        reason: current?.frequencyCode === '7' && state.isPreRelease(from) ? 'in_flight' : 'not_denied',
      };
    }
    const originalRef = await payerClaimNumber(tx, claim.id);
    if (!originalRef) return { status: 'refused', reason: 'no_payer_claim_number' };
    const [current] = await tx
      .select()
      .from(claimVersions)
      .where(eq(claimVersions.id, claim.currentVersionId));
    const before = current!.payload as ClaimPayload;
    let payload: ClaimPayload = { ...before, frequencyCode: '7' };
    let fixed = false;
    if (input.fix) {
      const res = applyFix(payload, input.fix.fix, input.fix.lineNumbers);
      if (!res.ok) {
        if (res.error === 'needs_editor') return { status: 'refused', reason: 'needs_editor' };
        if (res.error !== 'no_change') return { status: 'refused', reason: 'no_matching_line' };
      } else {
        payload = res.value.payload;
        fixed = true;
      }
    }
    const version = current!.version + 1;
    const versionId = await insertVersion(tx, claim, version, payload, actor);
    await tx.update(claimVersions).set({ originalRef }).where(eq(claimVersions.id, versionId));
    const changes = diffPayload(before, payload);
    if (changes.length)
      await tx.insert(corrections).values(
        changes.map((c) => ({
          tenantId: claim.tenantId,
          clientId: claim.clientId,
          workItemId: ctx.workItemId ?? null,
          claimId: claim.id,
          fieldPath: c.fieldPath,
          before: c.before ?? null,
          after: c.after ?? null,
          userId: ctx.userId,
        })),
      );
    await tx
      .update(claims)
      .set({ currentVersionId: versionId, totalChargeCents: payload.totalChargeCents, updatedAt: now })
      .where(eq(claims.id, claim.id));
    await applyClaimEvent(tx, claim, 'correct', {
      actor,
      versionId,
      payload: { version, frequencyCode: '7', originalRef, fields: changes.map((c) => c.fieldPath), fixed },
      now,
    });
    // Back through the scrub before release, like any new version.
    await applyClaimEvent(tx, { ...claim, status: 'corrected' }, 'edit', {
      actor,
      versionId,
      payload: { reason: 'correction' },
      now,
    });
    await recordAudit(tx, {
      actor,
      action: 'claim.correction_built',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { version, fixed, fields: changes.map((c) => c.fieldPath) },
    });
    return { status: 'built', versionId, version, originalRef, fixed };
  });
}

/** Release of a corrected version in Mode A: a task to resubmit it from the PM, with the changes. */
export async function resubmissionTask(
  tx: Tx,
  v: {
    claim: typeof claims.$inferSelect;
    connectionId: string;
    pmName: string;
    encounterExternalId: string;
    actor: AuditActor;
    now: Date;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, v.claim.id),
        eq(workItems.type, 'manual_task'),
        eq(workItems.reasonCode, RESUBMIT_OPERATION),
        ne(workItems.status, 'resolved'),
      ),
    );
  if (existing) return existing.id;
  const [version] = await tx
    .select()
    .from(claimVersions)
    .where(eq(claimVersions.id, v.claim.currentVersionId!));
  const [previous] = await tx
    .select()
    .from(claimVersions)
    .where(and(eq(claimVersions.claimId, v.claim.id), eq(claimVersions.version, version!.version - 1)));
  const changes = previous
    ? diffPayload(previous.payload as ClaimPayload, version!.payload as ClaimPayload).filter(
        (c) => c.fieldPath !== 'frequencyCode',
      )
    : [];
  const title = `Send the corrected claim from ${v.pmName}`;
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: v.claim.tenantId,
      clientId: v.claim.clientId,
      type: 'manual_task',
      priority: 2,
      dueAt: new Date(v.now.getTime() + 24 * 3_600_000),
      claimId: v.claim.id,
      encounterId: v.claim.encounterId,
      connectionId: v.connectionId,
      reasonCode: RESUBMIT_OPERATION,
      summary: `${title} (frequency 7).`,
      amountCents: v.claim.totalChargeCents,
    })
    .returning({ id: workItems.id });
  await tx.insert(manualTasks).values({
    tenantId: v.claim.tenantId,
    clientId: v.claim.clientId,
    connectionId: v.connectionId,
    operation: RESUBMIT_OPERATION,
    workItemId: item!.id,
    title,
    instructions: [
      `In ${v.pmName}, open the claim for visit ${v.encounterExternalId}.`,
      changes.length ? 'Make these changes to the charge:' : 'No charge changes: resubmit as is.',
      ...changes.map((c) => `Worksheet: ${c.label}`),
      `Resubmit it as a corrected claim: frequency code 7, original claim number ${version!.originalRef ?? '(see the remittance)'}.`,
      'Cleanpost sees the claim sent again at the next sync and tracks it from there.',
    ],
    payloadRef: version!.id,
  });
  await recordAudit(tx, {
    actor: v.actor,
    action: 'work_item.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: v.claim.clientId,
    metadata: { type: 'manual_task', operation: RESUBMIT_OPERATION, claimId: v.claim.id },
  });
  return item!.id;
}

export const RESUBMIT_OPERATION = 'resubmitCorrected';

/** The claim already has a corrected version on its way (D-02 shows its status instead). */
export async function correctionInFlight(tx: Tx, claimId: string): Promise<boolean> {
  const [ev] = await tx
    .select({ id: claimEvents.id })
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, 'corrected')))
    .limit(1);
  return Boolean(ev);
}
