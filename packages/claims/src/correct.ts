/**
 * Denial to corrected claim (Flow 5; C-09, W-16, D-02) and write-off (C-14, D-03).
 *
 * A corrected claim replaces an adjudicated one (CLAUDE.md rule 4): a new version with frequency 7
 * and the payer's claim control number as the original reference, scrubbed like any other version.
 * In Mode A the PM sends it: none of the PMs Cleanpost reaches today take a replacement claim
 * through their API, so release prepares a task to resubmit it from the PM, and the claim moves on
 * when the PM shows it sent again. The denial item closes itself when the corrected claim is
 * accepted. A write-off closes the balance with a reason, and a task posts the adjustment in the PM.
 */
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  claimEvents,
  claims,
  claimVersions,
  connections,
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
import {
  applyFix,
  diffPayload,
  formatCents,
  state,
  type ClaimPayload,
  type SuggestedFix,
} from '@cleanpost/domain';
import { applyClaimEvent, recordClaimEvent } from './events';
import { insertVersion } from './versions';

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
  now = new Date(),
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

/** Open items a corrected claim answers: they close when it is accepted or paid. */
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
  for (const item of open) {
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({ status: next.value, resolvedBy: actor, resolvedAt: now, resolution: why, updatedAt: now })
      .where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor,
      action: 'work_item.auto_resolve',
      entityType: 'work_item',
      entityId: item.id,
      clientId: claim.clientId,
      metadata: { type: item.type, reason: why },
    });
  }
  return open.length;
}

export const WRITE_OFF_REASONS = [
  'Not worth pursuing',
  'Timely filing missed',
  'Patient not covered and not billable',
  'Practice instruction',
  'Other',
] as const;

export type WriteOffOutcome =
  | { status: 'written_off'; amountCents: number; workItemId: string | null }
  | { status: 'refused'; reason: 'not_found' | 'not_open' | 'amount' | 'note_required' };

/**
 * C-14 / D-03 Write off: closes the claim's open balance (or part of it) with a reason the billing
 * company can report. In Mode A a task posts the adjustment in the PM with the given code.
 */
export async function writeOffClaim(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
  input: {
    amountCents: number;
    reason: (typeof WRITE_OFF_REASONS)[number];
    note: string | null;
    pmCode: string;
  },
  now = new Date(),
): Promise<WriteOffOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim) return { status: 'refused', reason: 'not_found' };
    const event: state.ClaimEvent = claim.status === 'denied' ? 'write_off' : 'close';
    if (
      !['denied', 'partially_paid'].includes(claim.status) ||
      !state.nextClaimState(claim.status as state.ClaimState, event).ok
    )
      return { status: 'refused', reason: 'not_open' };
    const balance = Number(claim.balanceCents);
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > balance)
      return { status: 'refused', reason: 'amount' };
    if ((input.reason === 'Other' || input.amountCents > 10_000) && !input.note?.trim())
      return { status: 'refused', reason: 'note_required' };
    const left = balance - input.amountCents;
    await tx.update(claims).set({ balanceCents: left, updatedAt: now }).where(eq(claims.id, claim.id));
    // A partial write-off leaves the claim open with the rest; a full one closes it.
    if (left === 0)
      await applyClaimEvent(tx, claim, event, {
        actor,
        versionId: claim.currentVersionId,
        payload: { writeOffCents: input.amountCents, reason: input.reason },
        now,
      });
    else
      await recordClaimEvent(tx, claim, 'written_off', {
        actor,
        versionId: claim.currentVersionId,
        payload: { writeOffCents: input.amountCents, reason: input.reason, left },
        now,
      });
    await recordAudit(tx, {
      actor,
      action: 'claim.written_off',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { amountCents: input.amountCents, reason: input.reason, full: left === 0 },
    });
    if (left === 0) await resolveAnsweredDenials(tx, claim, 'Written off', actor, now);

    // Mode A: the PM holds the balance; a person posts the adjustment there.
    const [conn] = await tx
      .select({ id: connections.id, settings: connections.settings })
      .from(connections)
      .where(eq(connections.clientId, claim.clientId))
      .limit(1);
    let workItemId: string | null = null;
    if (claim.mode === 'A' && conn) {
      const pmName = ((conn.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM';
      const title = `Write off ${formatCents(input.amountCents)} in ${pmName}`;
      const [item] = await tx
        .insert(workItems)
        .values({
          tenantId: claim.tenantId,
          clientId: claim.clientId,
          type: 'manual_task',
          priority: 3,
          dueAt: new Date(now.getTime() + 48 * 3_600_000),
          claimId: claim.id,
          encounterId: claim.encounterId,
          connectionId: conn.id,
          reasonCode: WRITE_OFF_OPERATION,
          summary: `${title} (${input.reason.toLowerCase()}).`,
          amountCents: input.amountCents,
        })
        .returning({ id: workItems.id });
      workItemId = item!.id;
      await tx.insert(manualTasks).values({
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        connectionId: conn.id,
        operation: WRITE_OFF_OPERATION,
        workItemId,
        title,
        instructions: [
          `In ${pmName}, open the claim with control number ${claim.patientControlNumber ?? '(see the claim)'}.`,
          `Post an adjustment of ${formatCents(input.amountCents)} with code ${input.pmCode.toUpperCase()} (${input.reason.toLowerCase()}).`,
          left > 0
            ? `${formatCents(left)} stays open on the claim.`
            : 'The claim balance should then be zero.',
          'Do not bill the patient for a contractual write-off.',
        ],
        payloadRef: claim.id,
      });
    }
    return { status: 'written_off', amountCents: input.amountCents, workItemId };
  });
}

export const WRITE_OFF_OPERATION = 'writeOff';

/** The claim already has a corrected version on its way (D-02 shows its status instead). */
export async function correctionInFlight(tx: Tx, claimId: string): Promise<boolean> {
  const [ev] = await tx
    .select({ id: claimEvents.id })
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, 'corrected')))
    .limit(1);
  return Boolean(ev);
}
