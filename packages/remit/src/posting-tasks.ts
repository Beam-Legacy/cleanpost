/**
 * Manual posting (M-01, M-02, F-02; docs/04-modes.md, docs/07 "Posting"): where Cleanpost can neither
 * post to nor read postings from the PM, each matched payment becomes one manual task with a
 * worksheet in the PM's own adjustment codes. A person enters it in the PM and marks it posted with
 * the PM's payment ID; the remittance is then reconciled on their word, recorded as theirs. If they
 * cannot finish, they say why and the task goes to an admin.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  claims,
  connections,
  coverages,
  encounters,
  manualTasks,
  memberships,
  recordAudit,
  remitAdjustments,
  remitClaims,
  remitLines,
  remittances,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import { formatCents, remit, state } from '@cleanpost/domain';
import { createWorkItem } from './items';

export const POSTING_OPERATION = 'postPayment';

/** Can Cleanpost read what this connection's PM posted (automatically, not by file)? */
export function readsPostings(levels: unknown): boolean {
  const level = (levels as Record<string, unknown> | null)?.pullPostings;
  return typeof level === 'number' && level > 0 && level !== 3;
}

/** The worksheet for one remittance's matched claims, in the PM's codes. */
export async function remittanceWorksheet(tx: Tx, remittanceId: string, lookup: remit.MappingLookup) {
  const rcs = await tx
    .select({ rc: remitClaims, dos: encounters.dateOfService, patientId: claims.patientId })
    .from(remitClaims)
    .innerJoin(claims, eq(claims.id, remitClaims.claimId))
    .innerJoin(encounters, eq(encounters.id, claims.encounterId))
    .where(and(eq(remitClaims.remittanceId, remittanceId), eq(remitClaims.matchStatus, 'matched')));
  const lines = rcs.length
    ? await tx
        .select()
        .from(remitLines)
        .where(
          inArray(
            remitLines.remitClaimId,
            rcs.map((x) => x.rc.id),
          ),
        )
    : [];
  const adj = lines.length
    ? await tx
        .select()
        .from(remitAdjustments)
        .where(
          inArray(
            remitAdjustments.remitLineId,
            lines.map((l) => l.id),
          ),
        )
    : [];
  const secondaries = rcs.length
    ? await tx
        .select({ patientId: coverages.patientId })
        .from(coverages)
        .where(
          and(
            inArray(
              coverages.patientId,
              rcs.map((x) => x.patientId),
            ),
            eq(coverages.priority, 2),
          ),
        )
    : [];
  return remit.postingWorksheet(
    rcs.map(({ rc, dos, patientId }) => ({
      patientControlNumber: rc.patientControlNumber ?? '',
      dateOfService: dos,
      hasSecondary: secondaries.some((s) => s.patientId === patientId),
      lines: lines
        .filter((l) => l.remitClaimId === rc.id)
        .map((l) => ({
          code: l.code,
          modifiers: l.modifiers,
          chargeCents: Number(l.chargeCents),
          paidCents: Number(l.paidCents),
          units: l.units,
          allowedCents: l.allowedCents === null ? null : Number(l.allowedCents),
          lineControlNumber: l.lineControlNumber,
          serviceDate: null,
          adjustments: adj
            .filter((a) => a.remitLineId === l.id)
            .map((a) => ({
              group: a.groupCode as remit.GroupCode,
              carc: a.carc,
              amountCents: Number(a.amountCents),
            })),
          remarks: [],
        })),
    })),
    lookup,
  );
}

/** One posting task per remittance, with the steps and the worksheet as its instructions. */
export async function ensurePostingTask(
  tx: Tx,
  v: {
    tenantId: string;
    clientId: string;
    connectionId: string;
    pmName: string;
    remittance: typeof remittances.$inferSelect;
    lookup: remit.MappingLookup;
    actor: AuditActor;
    now: Date;
  },
): Promise<string> {
  const r = v.remittance;
  const [existing] = await tx
    .select({ workItemId: manualTasks.workItemId })
    .from(manualTasks)
    .where(and(eq(manualTasks.payloadRef, r.id), eq(manualTasks.operation, POSTING_OPERATION)));
  if (existing?.workItemId) return existing.workItemId;
  const sheet = await remittanceWorksheet(tx, r.id, v.lookup);
  const method = r.paymentMethod === 'CHK' ? 'check' : r.paymentMethod === 'NON' ? 'no payment' : 'EFT';
  const amount = formatCents(Number(r.paymentAmountCents));
  const title = `Post ${amount} from ${r.payerName} in ${v.pmName}`;
  const itemId = await createWorkItem(
    tx,
    {
      tenantId: v.tenantId,
      clientId: v.clientId,
      type: 'manual_task',
      priority: 2,
      hours: 24,
      reasonCode: POSTING_OPERATION,
      summary: `${title} by hand (${sheet.rows.length} ${sheet.rows.length === 1 ? 'line' : 'lines'}).`,
      amountCents: Number(r.paymentAmountCents),
      remittanceId: r.id,
      connectionId: v.connectionId,
      now: v.now,
    },
    v.actor,
  );
  const steps = [
    `In ${v.pmName}, open payment posting and enter the ${method} from ${r.payerName}: trace ${r.traceNumber}, ${amount}, dated ${r.paymentDate}.`,
    'Enter each line below as listed, with the adjustment codes given; patient responsibility goes to the patient (or the secondary payer where noted).',
    'Leave denied lines open: they are in the denial queue.',
    sheet.unmapped.length
      ? `Some codes have no PM code yet (${sheet.unmapped.join(', ')}); an admin can map them, or ask before entering those amounts.`
      : null,
    `When the payment is entered, mark this task posted with ${v.pmName}'s payment ID.`,
  ].filter((s): s is string => Boolean(s));
  const worksheet = sheet.rows.map(
    (row) =>
      `Worksheet: ${row.patientControlNumber} · ${row.dateOfService} · ${row.code} · paid ${row.paid}` +
      `${row.adjustments ? ` · ${row.adjustments}` : ''} · patient ${row.patientResponsibility}${row.note ? ` · ${row.note}` : ''}`,
  );
  await tx.insert(manualTasks).values({
    tenantId: v.tenantId,
    clientId: v.clientId,
    connectionId: v.connectionId,
    operation: POSTING_OPERATION,
    workItemId: itemId,
    title,
    instructions: [...steps, ...worksheet],
    payloadRef: r.id,
  });
  return itemId;
}

type Refusal = 'not_found' | 'not_open' | 'reference_required';
export type PostingTaskOutcome = { ok: true } | { ok: false; reason: Refusal };

async function postingTask(tx: Tx, itemId: string) {
  const [item] = await tx.select().from(workItems).where(eq(workItems.id, itemId)).for('update');
  if (!item || item.type !== 'manual_task' || item.reasonCode !== POSTING_OPERATION) return null;
  const [task] = await tx.select().from(manualTasks).where(eq(manualTasks.workItemId, item.id)).for('update');
  return task ? { item, task } : null;
}

async function moveItem(
  tx: Tx,
  item: typeof workItems.$inferSelect,
  event: state.WorkItemEvent,
  set: Partial<typeof workItems.$inferInsert>,
  actor: AuditActor,
  now: Date,
) {
  const next = state.nextWorkItemState(item.status as state.WorkItemState, event);
  if (!next.ok) return false;
  await tx
    .update(workItems)
    .set({ status: next.value, updatedAt: now, ...set })
    .where(eq(workItems.id, item.id));
  await recordAudit(tx, {
    actor,
    action: `work_item.${event}`,
    entityType: 'work_item',
    entityId: item.id,
    clientId: item.clientId,
    metadata: { type: item.type, operation: POSTING_OPERATION },
  });
  return true;
}

/** M-01 Mark as posted, with the PM's payment ID: the remittance reconciles on this person's word. */
export async function confirmPosting(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: { itemId: string; pmReference: string },
  now = new Date(),
): Promise<PostingTaskOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const ref = input.pmReference.trim();
  if (!ref) return { ok: false, reason: 'reference_required' };
  const found = await postingTask(tx, input.itemId);
  if (!found) return { ok: false, reason: 'not_found' };
  const { item, task } = found;
  if (task.status === 'done' || item.status === 'resolved') return { ok: false, reason: 'not_open' };
  await tx
    .update(manualTasks)
    .set({ status: 'done', pmReference: ref.slice(0, 100), updatedAt: now })
    .where(eq(manualTasks.id, task.id));
  await moveItem(
    tx,
    item,
    'resolve',
    { resolvedBy: actor, resolvedAt: now, resolution: 'Posted in the PM' },
    actor,
    now,
  );
  if (item.remittanceId) {
    const [r] = await tx
      .select()
      .from(remittances)
      .where(eq(remittances.id, item.remittanceId))
      .for('update');
    const next = r ? state.nextRemittanceState(r.status as state.RemittanceState, 'posting_match') : null;
    if (r && next?.ok) {
      await tx
        .update(remittances)
        .set({ status: next.value, updatedAt: now })
        .where(eq(remittances.id, r.id));
      const rcs = await tx
        .select({ id: remitClaims.id })
        .from(remitClaims)
        .where(and(eq(remitClaims.remittanceId, r.id), eq(remitClaims.matchStatus, 'matched')));
      if (rcs.length)
        await tx
          .update(remitLines)
          .set({ verifyStatus: 'confirmed', verifyDetail: null, verifiedAt: now, updatedAt: now })
          .where(
            inArray(
              remitLines.remitClaimId,
              rcs.map((x) => x.id),
            ),
          );
    }
  }
  await recordAudit(tx, {
    actor,
    action: 'manual_task.completed',
    entityType: 'manual_task',
    entityId: task.id,
    clientId: task.clientId,
    metadata: { operation: POSTING_OPERATION, remittanceId: item.remittanceId },
  });
  return { ok: true };
}

/** M-02 reasons. */
export const ESCALATION_REASONS = [
  'The PM would not accept a value',
  'Claim or charge not found in the PM',
  'Amounts differ from what the PM shows',
  'No access in the PM',
  'Other',
] as const;

/** M-02 Couldn't complete: the reason, then the task goes to the company's owner (an admin). */
export async function escalatePosting(
  tx: Tx,
  ctx: { tenantId: string; userId: string },
  input: { itemId: string; reason: (typeof ESCALATION_REASONS)[number]; note: string | null },
  now = new Date(),
): Promise<PostingTaskOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const found = await postingTask(tx, input.itemId);
  if (!found) return { ok: false, reason: 'not_found' };
  const { item, task } = found;
  if (task.status === 'done' || item.status === 'resolved') return { ok: false, reason: 'not_open' };
  const [owner] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, ctx.tenantId),
        eq(memberships.role, 'admin'),
        eq(memberships.isOwner, true),
      ),
    )
    .limit(1);
  await tx
    .update(manualTasks)
    .set({
      status: 'escalated',
      // Shown on the task to the admin it goes to; the database is where patient details may live.
      instructions: [
        ...task.instructions,
        `Escalated: ${input.reason}${input.note ? ` — ${input.note.slice(0, 500)}` : ''}`,
      ],
      updatedAt: now,
    })
    .where(eq(manualTasks.id, task.id));
  await tx
    .update(workItems)
    .set({
      priority: 1,
      summary: `Escalated: ${input.reason}. ${item.summary}`.slice(0, 300),
      ...(owner ? { assigneeId: owner.userId } : {}),
      updatedAt: now,
    })
    .where(eq(workItems.id, item.id));
  if (owner && item.status === 'open') await moveItem(tx, item, 'assign', {}, actor, now);
  await recordAudit(tx, {
    actor,
    action: 'manual_task.escalated',
    entityType: 'manual_task',
    entityId: task.id,
    clientId: task.clientId,
    // The note can name a patient: it stays out of the audit metadata.
    metadata: { operation: POSTING_OPERATION, reason: input.reason, hasNote: Boolean(input.note) },
  });
  return { ok: true };
}

/** The connection the posting task belongs to, with whether Cleanpost can read its postings. */
export async function postingConnection(tx: Tx, clientId: string) {
  const [conn] = await tx
    .select({ id: connections.id, levels: connections.levels, settings: connections.settings })
    .from(connections)
    .where(and(eq(connections.clientId, clientId), ne(connections.status, 'disconnected')))
    .limit(1);
  if (!conn) return null;
  return {
    id: conn.id,
    readsPostings: readsPostings(conn.levels),
    pmName: ((conn.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
  };
}
