/**
 * Work item actions a person takes from the queue (W-06 Snooze, W-07 Resolve, Undo), each through
 * the work-item state machine (CLAUDE.md rule 6), recorded with the actor and audit-logged.
 * Authorization (work.resolve) is the caller's: these run inside the caller's tenant.
 */
import { and, eq, lte, ne } from 'drizzle-orm';
import {
  notifications,
  recordAudit,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { state, work } from '@cleanpost/domain';
import { now as clockNow } from '@cleanpost/clock';

export type WorkActionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_transition'
        | 'past'
        | 'too_far'
        | 'unknown_reason'
        | 'note_required'
        | 'decided_elsewhere';
    };

interface Ctx {
  tenantId: string;
  userId: string;
  now?: Date;
}

async function locked(tx: Tx, id: string) {
  const [item] = await tx.select().from(workItems).where(eq(workItems.id, id)).for('update');
  return item ?? null;
}

async function move(
  tx: Tx,
  item: typeof workItems.$inferSelect,
  event: state.WorkItemEvent,
  set: Partial<typeof workItems.$inferInsert>,
  actor: AuditActor,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<WorkActionResult> {
  const next = state.nextWorkItemState(item.status as state.WorkItemState, event);
  if (!next.ok) return { ok: false, reason: 'invalid_transition' };
  await tx
    .update(workItems)
    .set({ ...set, status: next.value, updatedAt: clockNow() })
    .where(eq(workItems.id, item.id));
  await recordAudit(tx, {
    actor,
    action,
    entityType: 'work_item',
    entityId: item.id,
    clientId: item.clientId,
    metadata: { type: item.type, from: item.status, to: next.value, ...metadata },
  });
  return { ok: true };
}

/** W-06: hide until a time. Never moves the SLA (due_at stays). */
export async function snoozeItem(
  db: Database,
  ctx: Ctx,
  itemId: string,
  until: Date,
): Promise<WorkActionResult> {
  const now = ctx.now ?? clockNow();
  const check = work.checkSnooze(now, until);
  if (!check.ok) return { ok: false, reason: check.error };
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const item = await locked(tx, itemId);
    if (!item) return { ok: false, reason: 'not_found' };
    return move(tx, item, 'snooze', { snoozedUntil: until }, `user:${ctx.userId}`, 'work_item.snoozed', {
      until: until.toISOString(),
    });
  });
}

/** Undo of a snooze, or waking an item early. */
export async function wakeItem(db: Database, ctx: Ctx, itemId: string): Promise<WorkActionResult> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const item = await locked(tx, itemId);
    if (!item) return { ok: false, reason: 'not_found' };
    return move(tx, item, 'wake', { snoozedUntil: null }, `user:${ctx.userId}`, 'work_item.woken');
  });
}

/** W-07: resolve with a reason from the item type's list (and a note for Other). */
export async function resolveItem(
  db: Database,
  ctx: Ctx,
  itemId: string,
  input: { reason: string; note?: string | null },
): Promise<WorkActionResult> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const item = await locked(tx, itemId);
    if (!item) return { ok: false, reason: 'not_found' };
    // An approval closes only by its decision (Approve or Decline), which does the write-off.
    if (work.DECIDED_TYPES.includes(item.type as work.WorkItemType))
      return { ok: false, reason: 'decided_elsewhere' };
    const check = work.checkResolution(item.type, input.reason, input.note ?? null);
    if (!check.ok) return { ok: false, reason: check.error };
    const note = input.note?.trim();
    const actor: AuditActor = `user:${ctx.userId}`;
    return move(
      tx,
      item,
      'resolve',
      {
        resolvedBy: actor,
        resolution: note ? `${input.reason}: ${note}` : input.reason,
        resolvedAt: ctx.now ?? clockNow(),
        snoozedUntil: null,
      },
      actor,
      'work_item.resolved',
      // The reason is from a fixed list; the free-text note stays out of the audit metadata.
      { reason: input.reason, hasNote: Boolean(note) },
    );
  });
}

/** Undo of a resolve. */
export async function reopenItem(db: Database, ctx: Ctx, itemId: string): Promise<WorkActionResult> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const item = await locked(tx, itemId);
    if (!item) return { ok: false, reason: 'not_found' };
    if (work.DECIDED_TYPES.includes(item.type as work.WorkItemType))
      return { ok: false, reason: 'decided_elsewhere' };
    return move(
      tx,
      item,
      'reopen',
      { resolvedBy: null, resolution: null, resolvedAt: null },
      `user:${ctx.userId}`,
      'work_item.reopened',
    );
  });
}

/**
 * Snoozed items whose time has come go back to open (actor automation). Runs inside the caller's
 * tenant transaction when the queue loads, so a woken item is in the list that same moment.
 */
export async function wakeDueItems(tx: Tx, now: Date): Promise<number> {
  const due = await tx
    .select()
    .from(workItems)
    .where(and(eq(workItems.status, 'snoozed'), lte(workItems.snoozedUntil, now)))
    .for('update', { skipLocked: true });
  for (const item of due) {
    await move(tx, item, 'wake', { snoozedUntil: null }, 'automation:work.wake', 'work_item.woken');
  }
  return due.length;
}

/**
 * W-05: hand an item to a teammate (or take it back to unassigned). The caller checks that the
 * assignee may see the item's client. The new assignee gets an in-app notification.
 */
export async function assignItem(
  db: Database,
  ctx: Ctx,
  itemId: string,
  assigneeId: string | null,
): Promise<WorkActionResult> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const item = await locked(tx, itemId);
    if (!item) return { ok: false, reason: 'not_found' };
    if (item.assigneeId === assigneeId) return { ok: true };
    const actor: AuditActor = `user:${ctx.userId}`;
    // Snoozed items keep their snooze; the assignee is recorded either way.
    const event: state.WorkItemEvent | null =
      item.status === 'snoozed'
        ? null
        : assigneeId
          ? 'assign'
          : item.status === 'assigned' || item.status === 'in_progress'
            ? 'unassign'
            : null;
    if (event) {
      const res = await move(
        tx,
        item,
        event,
        { assigneeId },
        actor,
        assigneeId ? 'work_item.assigned' : 'work_item.unassigned',
        {
          assigneeId,
        },
      );
      if (!res.ok) return res;
    } else {
      await tx.update(workItems).set({ assigneeId, updatedAt: clockNow() }).where(eq(workItems.id, item.id));
      await recordAudit(tx, {
        actor,
        action: assigneeId ? 'work_item.assigned' : 'work_item.unassigned',
        entityType: 'work_item',
        entityId: item.id,
        clientId: item.clientId,
        metadata: { assigneeId },
      });
    }
    if (assigneeId && assigneeId !== ctx.userId) {
      await tx.insert(notifications).values({
        tenantId: ctx.tenantId,
        userId: assigneeId,
        type: 'work_item.assigned',
        entityType: 'work_item',
        entityId: item.id,
        summary: `Assigned to you: ${work.WORK_TYPE_LABEL[item.type as work.WorkItemType] ?? item.type}`,
      });
    }
    return { ok: true };
  });
}

/**
 * S-03: hand back the open items assigned to someone who was deactivated (keep: 'none') or no longer
 * sees some clients (keep: the clients they still have). Each goes back to the queue unassigned,
 * through assignItem, so the change is recorded on the item and audited. Returns how many.
 */
export async function unassignItemsOf(
  db: Database,
  ctx: Ctx,
  userId: string,
  keep: 'all' | 'none' | string[],
): Promise<number> {
  if (keep === 'all') return 0;
  const items = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    tx
      .select({ id: workItems.id, clientId: workItems.clientId })
      .from(workItems)
      .where(and(eq(workItems.assigneeId, userId), ne(workItems.status, 'resolved'))),
  );
  let n = 0;
  for (const item of items) {
    if (keep !== 'none' && item.clientId && keep.includes(item.clientId)) continue;
    if ((await assignItem(db, ctx, item.id, null)).ok) n++;
  }
  return n;
}
