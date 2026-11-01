/**
 * Connection status changes and the work items that follow them. Every status change goes through
 * the connection state machine (CLAUDE.md rule 6) and is audit-logged with its actor; a degraded or
 * failed connection gets one open `sync_failure` item (docs/08-work-queue.md), resolved by automation
 * when the connection is healthy again.
 */
import { and, eq, ne } from 'drizzle-orm';
import { state } from '@cleanpost/domain';
import { clients, connections, recordAudit, workItems, type AuditActor, type Tx } from '@cleanpost/db';

export type ConnectionRow = typeof connections.$inferSelect;

export interface FailureReason {
  code: string;
  message: string;
}

export interface EventResult {
  from: state.ConnectionState;
  to: state.ConnectionState;
  applied: boolean;
}

const SLA_HOURS = 4;

async function openSyncFailureItems(tx: Tx, connectionId: string) {
  return tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.connectionId, connectionId),
        eq(workItems.type, 'sync_failure'),
        ne(workItems.status, 'resolved'),
      ),
    );
}

async function ensureSyncFailureItem(
  tx: Tx,
  conn: ConnectionRow,
  to: 'degraded' | 'failed',
  reason: FailureReason,
  actor: AuditActor,
  now: Date,
) {
  const [client] = await tx.select({ name: clients.name }).from(clients).where(eq(clients.id, conn.clientId));
  const pmName =
    typeof (conn.settings as Record<string, unknown>).pmName === 'string'
      ? ((conn.settings as Record<string, unknown>).pmName as string)
      : 'PM';
  const summary = `${client?.name ?? 'Client'}: ${pmName} connection ${to === 'failed' ? 'failed' : 'is degraded'}. ${reason.message}`;
  const [existing] = await openSyncFailureItems(tx, conn.id);
  if (existing) {
    await tx
      .update(workItems)
      .set({ summary, reasonCode: reason.code, priority: 1, updatedAt: now })
      .where(eq(workItems.id, existing.id));
    return;
  }
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: conn.tenantId,
      clientId: conn.clientId,
      type: 'sync_failure',
      priority: 1,
      dueAt: new Date(now.getTime() + SLA_HOURS * 3_600_000),
      connectionId: conn.id,
      reasonCode: reason.code,
      summary,
    })
    .returning({ id: workItems.id });
  await recordAudit(tx, {
    actor,
    action: 'work_item.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: conn.clientId,
    metadata: { type: 'sync_failure', connectionId: conn.id, reasonCode: reason.code },
  });
}

async function resolveSyncFailureItems(tx: Tx, conn: ConnectionRow, actor: AuditActor, now: Date) {
  for (const item of await openSyncFailureItems(tx, conn.id)) {
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({
        status: next.value,
        resolvedBy: actor,
        resolution: 'Connection recovered',
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor,
      action: 'work_item.resolved',
      entityType: 'work_item',
      entityId: item.id,
      clientId: conn.clientId,
      metadata: { type: 'sync_failure', resolution: 'auto' },
    });
  }
}

/**
 * Applies a connection event inside the caller's tenant transaction. An event the state machine
 * does not allow (say, a sync finishing after an admin paused the connection) leaves the status as
 * it is; the other fields are still saved.
 */
export async function applyConnectionEvent(
  tx: Tx,
  conn: ConnectionRow,
  event: state.ConnectionEvent,
  opts: {
    actor: AuditActor;
    now: Date;
    reason?: FailureReason;
    set?: Partial<Pick<ConnectionRow, 'lastSuccessAt' | 'consecutiveFailedCycles' | 'nextRunAt'>>;
  },
): Promise<EventResult> {
  const from = conn.status as state.ConnectionState;
  const next = state.nextConnectionState(from, event);
  const to = next.ok ? next.value : from;
  await tx
    .update(connections)
    .set({ ...opts.set, ...(next.ok ? { status: to } : {}), updatedAt: opts.now })
    .where(eq(connections.id, conn.id));
  if (next.ok && to !== from) {
    await recordAudit(tx, {
      actor: opts.actor,
      action: 'connection.status_changed',
      entityType: 'connection',
      entityId: conn.id,
      clientId: conn.clientId,
      metadata: { from, to, event, ...(opts.reason ? { reasonCode: opts.reason.code } : {}) },
    });
  }
  if (next.ok && (to === 'degraded' || to === 'failed')) {
    await ensureSyncFailureItem(
      tx,
      conn,
      to,
      opts.reason ?? { code: event.toUpperCase(), message: 'Syncing is not working.' },
      opts.actor,
      opts.now,
    );
  }
  if (next.ok && to === 'healthy') await resolveSyncFailureItems(tx, conn, opts.actor, opts.now);
  return { from, to, applied: next.ok };
}

/** Locks and reads a connection in the current tenant. */
export async function lockConnection(tx: Tx, connectionId: string): Promise<ConnectionRow | undefined> {
  const [row] = await tx.select().from(connections).where(eq(connections.id, connectionId)).for('update');
  return row;
}
