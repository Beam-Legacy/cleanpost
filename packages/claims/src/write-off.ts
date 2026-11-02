/**
 * Write-off (C-14, D-03): closes a denial's balance, or part of it, with a reason the billing
 * company can report to its client, separate from what was corrected.
 *
 * - A biller writes off up to the tenant's approval limit alone (default $500,
 *   `tenants.settings.writeOffApprovalLimitCents`). Above it the write-off is a request an admin
 *   approves or declines (D-03 "Request approval"); approving does the write-off as the admin, with
 *   the requester recorded.
 * - The default amount is the denied amount, never what the patient owes on other lines.
 * - In Mode A a task posts the adjustment in the PM with the PM's own code (CLAUDE.md rule 8: a
 *   person does the PM write; nothing is sent from here).
 */
import { and, eq } from 'drizzle-orm';
import {
  claims,
  connections,
  manualTasks,
  notifications,
  recordAudit,
  tenants,
  withTenant,
  workItems,
  writeOffRequests,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { formatCents, remit, state } from '@cleanpost/domain';
import { autoResolve, resolveAnsweredDenials } from './answered';
import { applyClaimEvent, recordClaimEvent } from './events';

export const WRITE_OFF_REASONS = [
  'Not worth pursuing',
  'Timely filing missed',
  'Patient not covered and not billable',
  'Practice instruction',
  'Other',
] as const;

export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export const WRITE_OFF_OPERATION = 'writeOff';

/** A note is needed for "Other" and for amounts over $100 (reported to the client). */
export const WRITE_OFF_NOTE_OVER_CENTS = 10_000;

export interface WriteOffInput {
  amountCents: number;
  reason: WriteOffReason;
  note: string | null;
  pmCode: string;
  /** The denial item this answers: it closes when the amount covers it. */
  denialItemId?: string | null;
  /** The denial had a suggested correction the person chose not to take (D-02: recorded). */
  suggestionNotTaken?: boolean;
}

export type WriteOffRefusal =
  'not_found' | 'not_open' | 'amount' | 'note_required' | 'over_limit' | 'already_requested';

export type WriteOffOutcome =
  | { status: 'written_off'; amountCents: number; workItemId: string | null }
  | { status: 'refused'; reason: WriteOffRefusal };

type ClaimRow = typeof claims.$inferSelect;

/** The tenant's approval limit (D-03). */
export async function approvalLimitCents(tx: Tx, tenantId: string): Promise<number> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  return remit.writeOffApprovalLimit(t?.settings);
}

function check(claim: ClaimRow | undefined, input: WriteOffInput): WriteOffRefusal | null {
  if (!claim) return 'not_found';
  const event: state.ClaimEvent = claim.status === 'denied' ? 'write_off' : 'close';
  if (
    !['denied', 'partially_paid'].includes(claim.status) ||
    !state.nextClaimState(claim.status as state.ClaimState, event).ok
  )
    return 'not_open';
  const balance = Number(claim.balanceCents);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > balance)
    return 'amount';
  if ((input.reason === 'Other' || input.amountCents > WRITE_OFF_NOTE_OVER_CENTS) && !input.note?.trim())
    return 'note_required';
  return null;
}

/** The write-off itself, on a claim row locked by the caller. */
async function writeOffInTx(
  tx: Tx,
  claim: ClaimRow,
  input: WriteOffInput,
  actor: AuditActor,
  now: Date,
  extra: { requestedBy?: string; requestId?: string } = {},
): Promise<WriteOffOutcome> {
  const refused = check(claim, input);
  if (refused) return { status: 'refused', reason: refused };
  const event: state.ClaimEvent = claim.status === 'denied' ? 'write_off' : 'close';
  const left = Number(claim.balanceCents) - input.amountCents;
  await tx.update(claims).set({ balanceCents: left, updatedAt: now }).where(eq(claims.id, claim.id));
  const payload = { writeOffCents: input.amountCents, reason: input.reason, ...extra };
  // A partial write-off leaves the claim open with the rest; a full one closes it.
  if (left === 0)
    await applyClaimEvent(tx, claim, event, { actor, versionId: claim.currentVersionId, payload, now });
  else
    await recordClaimEvent(tx, claim, 'written_off', {
      actor,
      versionId: claim.currentVersionId,
      payload: { ...payload, left },
      now,
    });
  await recordAudit(tx, {
    actor,
    action: 'claim.written_off',
    entityType: 'claim',
    entityId: claim.id,
    clientId: claim.clientId,
    metadata: {
      amountCents: input.amountCents,
      reason: input.reason,
      full: left === 0,
      ...extra,
      ...(input.suggestionNotTaken ? { suggestion: 'not_taken' } : {}),
    },
  });

  if (left === 0) await resolveAnsweredDenials(tx, claim, 'Written off', actor, now);
  else if (input.denialItemId) {
    // What the patient owes on other lines stays open; the denial is answered once it is covered.
    const [item] = await tx
      .select()
      .from(workItems)
      .where(and(eq(workItems.id, input.denialItemId), eq(workItems.claimId, claim.id)))
      .for('update');
    if (item && item.status !== 'resolved') {
      const risk = Number(item.amountCents ?? 0) - input.amountCents;
      if (risk <= 0) await autoResolve(tx, item, 'Written off', actor, now);
      else
        await tx
          .update(workItems)
          .set({ amountCents: risk, updatedAt: now })
          .where(eq(workItems.id, item.id));
    }
  }

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
        left > 0 ? `${formatCents(left)} stays open on the claim.` : 'The claim balance should then be zero.',
        'Do not bill the patient for a contractual write-off.',
      ],
      payloadRef: claim.id,
    });
  }
  return { status: 'written_off', amountCents: input.amountCents, workItemId };
}

/**
 * C-14 / D-03 Write off. `overLimit` is the caller's policy decision (an admin may go above the
 * tenant's approval limit; a biller may not and asks with requestWriteOff instead).
 */
export async function writeOffClaim(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; overLimit?: 'allowed' | 'refused' },
  input: WriteOffInput,
  now = new Date(),
): Promise<WriteOffOutcome> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim) return { status: 'refused', reason: 'not_found' };
    if (ctx.overLimit !== 'allowed' && input.amountCents > (await approvalLimitCents(tx, ctx.tenantId)))
      return { status: 'refused', reason: 'over_limit' };
    return writeOffInTx(tx, claim, input, `user:${ctx.userId}`, now);
  });
}

export type RequestOutcome =
  | { status: 'requested'; requestId: string; approvalItemId: string }
  | { status: 'refused'; reason: WriteOffRefusal };

/** D-03 Request approval: a write-off over the limit waits for an admin as a work item. */
export async function requestWriteOff(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
  input: WriteOffInput,
  now = new Date(),
): Promise<RequestOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    const refused = check(claim, input);
    if (refused || !claim) return { status: 'refused', reason: refused ?? 'not_found' };
    const [waiting] = await tx
      .select({ id: writeOffRequests.id })
      .from(writeOffRequests)
      .where(and(eq(writeOffRequests.claimId, claim.id), eq(writeOffRequests.status, 'pending')));
    if (waiting) return { status: 'refused', reason: 'already_requested' };
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        type: 'write_off_approval',
        priority: 2,
        dueAt: new Date(now.getTime() + 24 * 3_600_000),
        claimId: claim.id,
        encounterId: claim.encounterId,
        reasonCode: 'over_approval_limit',
        summary: `Approve a write-off of ${formatCents(input.amountCents)} (${input.reason.toLowerCase()}).`,
        amountCents: input.amountCents,
      })
      .returning({ id: workItems.id });
    const [req] = await tx
      .insert(writeOffRequests)
      .values({
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        claimId: claim.id,
        denialItemId: input.denialItemId ?? null,
        approvalItemId: item!.id,
        amountCents: input.amountCents,
        reason: input.reason,
        note: input.note?.trim() || null,
        pmCode: input.pmCode.toUpperCase(),
        requestedBy: ctx.userId,
      })
      .returning({ id: writeOffRequests.id });
    // The note is free text: it stays out of the audit metadata.
    await recordAudit(tx, {
      actor,
      action: 'write_off_request.created',
      entityType: 'write_off_request',
      entityId: req!.id,
      clientId: claim.clientId,
      metadata: {
        claimId: claim.id,
        amountCents: input.amountCents,
        reason: input.reason,
        ...(input.suggestionNotTaken ? { suggestion: 'not_taken' } : {}),
      },
    });
    return { status: 'requested', requestId: req!.id, approvalItemId: item!.id };
  });
}

export type DecideOutcome =
  | { status: 'approved'; workItemId: string | null }
  | { status: 'declined' }
  | { status: 'refused'; reason: WriteOffRefusal | 'not_pending' };

/**
 * An admin approves (the write-off is done now, as the admin, with the requester recorded) or
 * declines (the denial stays open for the biller). Either way the requester is notified.
 */
export async function decideWriteOff(
  db: Database,
  ctx: { tenantId: string; userId: string; requestId: string },
  decision: 'approve' | 'decline',
  note: string | null,
  now = new Date(),
): Promise<DecideOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [req] = await tx
      .select()
      .from(writeOffRequests)
      .where(eq(writeOffRequests.id, ctx.requestId))
      .for('update');
    if (!req) return { status: 'refused', reason: 'not_found' };
    const next = state.nextWriteOffRequestState(req.status as state.WriteOffRequestState, decision);
    if (!next.ok) return { status: 'refused', reason: 'not_pending' };

    const input: WriteOffInput = {
      amountCents: req.amountCents,
      reason: req.reason as WriteOffReason,
      note: req.note,
      pmCode: req.pmCode,
      denialItemId: req.denialItemId,
    };
    const [claim] =
      decision === 'approve'
        ? await tx.select().from(claims).where(eq(claims.id, req.claimId)).for('update')
        : [];
    if (decision === 'approve') {
      // Checked before anything is written: the balance may have changed since the request.
      const refused = check(claim, input);
      if (refused) return { status: 'refused', reason: refused };
    }
    // Decided first, so the write-off below does not cancel this request as moot.
    await tx
      .update(writeOffRequests)
      .set({
        status: next.value,
        decidedBy: actor,
        decidedAt: now,
        decisionNote: note?.trim() || null,
        updatedAt: now,
      })
      .where(eq(writeOffRequests.id, req.id));
    await recordAudit(tx, {
      actor,
      action: `write_off_request.${next.value}`,
      entityType: 'write_off_request',
      entityId: req.id,
      clientId: req.clientId,
      metadata: {
        claimId: req.claimId,
        amountCents: req.amountCents,
        requestedBy: `user:${req.requestedBy}`,
      },
    });
    if (req.approvalItemId) {
      const [item] = await tx.select().from(workItems).where(eq(workItems.id, req.approvalItemId));
      const to = item ? state.nextWorkItemState(item.status as state.WorkItemState, 'resolve') : null;
      if (item && to?.ok)
        await tx
          .update(workItems)
          .set({
            status: to.value,
            resolvedBy: actor,
            resolvedAt: now,
            resolution: decision === 'approve' ? 'Approved' : 'Declined',
            updatedAt: now,
          })
          .where(eq(workItems.id, item.id));
    }
    let workItemId: string | null = null;
    if (decision === 'approve' && claim) {
      const done = await writeOffInTx(tx, claim, input, actor, now, {
        requestedBy: `user:${req.requestedBy}`,
        requestId: req.id,
      });
      if (done.status === 'refused') throw new Error('write-off refused after its check');
      workItemId = done.workItemId;
    }
    await tx.insert(notifications).values({
      tenantId: req.tenantId,
      userId: req.requestedBy,
      type: decision === 'approve' ? 'write_off_approved' : 'write_off_declined',
      entityType: 'claim',
      entityId: req.claimId,
      summary: `Your write-off of ${formatCents(req.amountCents)} was ${decision === 'approve' ? 'approved' : 'declined'}.`,
    });
    return decision === 'approve' ? { status: 'approved', workItemId } : { status: 'declined' };
  });
}

export interface BulkWriteOffResult {
  writtenOff: number;
  cents: number;
  refused: { itemId: string; reason: WriteOffRefusal }[];
}

/**
 * D-03 bulk (admin): each denial's denied amount (capped at the claim's balance), one reason and
 * code for all. Each claim is its own transaction, so one refusal does not stop the rest.
 */
export async function writeOffDenials(
  db: Database,
  ctx: { tenantId: string; userId: string },
  itemIds: string[],
  input: { reason: WriteOffReason; note: string | null; pmCode: string },
  now = new Date(),
): Promise<BulkWriteOffResult> {
  const out: BulkWriteOffResult = { writtenOff: 0, cents: 0, refused: [] };
  for (const itemId of itemIds) {
    const res = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
      const [item] = await tx.select().from(workItems).where(eq(workItems.id, itemId));
      if (!item?.claimId || item.type !== 'denial' || item.status === 'resolved')
        return { status: 'refused', reason: 'not_open' } as const;
      const [claim] = await tx.select().from(claims).where(eq(claims.id, item.claimId)).for('update');
      if (!claim) return { status: 'refused', reason: 'not_found' } as const;
      const amountCents = remit.writeOffDefaultCents(
        Number(item.amountCents ?? 0),
        Number(claim.balanceCents),
      );
      return writeOffInTx(
        tx,
        claim,
        { ...input, amountCents, denialItemId: item.id },
        `user:${ctx.userId}`,
        now,
      );
    });
    if (res.status === 'written_off') {
      out.writtenOff++;
      out.cents += res.amountCents;
    } else out.refused.push({ itemId, reason: res.reason });
  }
  return out;
}
