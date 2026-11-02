/**
 * Mode A release and hold (docs/04-modes.md). Cleanpost never sends the claim itself in Mode A:
 * releasing tells the PM it may bill the charge (Tebra: approve the encounter in review).
 *
 * - releaseCharge automatic (levels 1, 2, 4): call the adapter; on success the claim is submitted.
 * - releaseCharge 'unavailable': the PM bills on its own schedule; the claim is submitted now.
 * - releaseCharge manual (0): one manual task and work item for a biller; the claim stays ready
 *   until the task is done or the PM shows the charge billed.
 *
 * Every write goes through the claim state machine, with the actor, and is audit-logged.
 */
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { AdapterRegistry, Connection } from '@cleanpost/adapters';
import {
  claimEvents,
  claims,
  claimVersions,
  clientPayerSettings,
  clients,
  connections,
  encounters,
  externalRefs,
  recordAudit,
  scrubResults,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { applyClaimEvent } from './events';
import { ensureManualTask, openCorrectionTasks } from './tasks';

export { ensureManualTask } from './tasks';

export interface ReleaseDeps {
  db: Database;
  registry: AdapterRegistry;
  log: Logger;
  now?: () => Date;
}

export type ReleaseOutcome =
  | { status: 'released'; via: 'adapter' | 'pm_schedule' }
  | { status: 'manual_task'; workItemId: string }
  | {
      status: 'refused';
      reason:
        | 'not_found'
        | 'not_ready'
        | 'needs_approval'
        | 'mode_not_built'
        | 'no_connection'
        /** A correction is waiting to be made in the PM; releasing now would bill the old charge. */
        | 'pm_correction_pending';
    }
  | { status: 'failed'; code: string; retryable: boolean; message: string };

interface ReleaseContext {
  claim: typeof claims.$inferSelect;
  conn: Connection;
  encounterExternalId: string;
}

function toConnection(row: typeof connections.$inferSelect): Connection {
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    adapterKey: row.adapterKey as Connection['adapterKey'],
    credentialsSecretRef: row.credentialsSecretRef,
    pmAccountRef: row.pmAccountRef,
    settings: (row.settings ?? {}) as Record<string, unknown>,
  };
}

/** The connection and the PM's encounter number for a claim. */
async function pmTarget(tx: Tx, claim: typeof claims.$inferSelect) {
  const [conn] = await tx.select().from(connections).where(eq(connections.clientId, claim.clientId)).limit(1);
  if (!conn) return null;
  const [ref] = await tx
    .select({ externalId: externalRefs.externalId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connectionId, conn.id),
        eq(externalRefs.entityType, 'encounter'),
        eq(externalRefs.entityId, claim.encounterId),
      ),
    );
  if (!ref) return null;
  return { conn: toConnection(conn), encounterExternalId: ref.externalId };
}

async function load(
  tx: Tx,
  claimId: string,
): Promise<ReleaseContext | Extract<ReleaseOutcome, { status: 'refused' }>> {
  const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId));
  if (!claim || !claim.currentVersionId) return { status: 'refused', reason: 'not_found' };
  if (claim.mode !== 'A') return { status: 'refused', reason: 'mode_not_built' };
  const [version] = await tx.select().from(claimVersions).where(eq(claimVersions.id, claim.currentVersionId));
  const [result] = version?.scrubResultId
    ? await tx.select().from(scrubResults).where(eq(scrubResults.id, version.scrubResultId))
    : [];
  const [client] = await tx.select().from(clients).where(eq(clients.id, claim.clientId));
  const [settings] = claim.payerId
    ? await tx
        .select()
        .from(clientPayerSettings)
        .where(
          and(
            eq(clientPayerSettings.clientId, claim.clientId),
            eq(clientPayerSettings.payerId, claim.payerId),
          ),
        )
    : [];
  const [approval] = await tx
    .select({ actor: claimEvents.actor })
    .from(claimEvents)
    .where(
      and(
        eq(claimEvents.claimId, claim.id),
        eq(claimEvents.claimVersionId, claim.currentVersionId),
        eq(claimEvents.type, 'approved'),
      ),
    )
    .orderBy(desc(claimEvents.occurredAt))
    .limit(1);
  const allowed = state.canRelease({
    state: claim.status as state.ClaimState,
    decision: (result?.decision ?? null) as state.ScrubDecision | null,
    confidence: result?.confidence ?? null,
    threshold: settings?.autoReleaseThresholdOverride ?? client?.autoReleaseThreshold ?? 90,
    approvedBy: approval?.actor ?? null,
  });
  if (!allowed.ok) return { status: 'refused', reason: allowed.error };
  if ((await openCorrectionTasks(tx, claim.id)).length)
    return { status: 'refused', reason: 'pm_correction_pending' };
  const target = await pmTarget(tx, claim);
  if (!target) return { status: 'refused', reason: 'no_connection' };
  return { claim, ...target };
}

export async function markReleased(
  tx: Tx,
  claim: typeof claims.$inferSelect,
  via: 'adapter' | 'pm_schedule' | 'pm_outside_cleanpost',
  actor: AuditActor,
  now: Date,
) {
  await tx
    .update(claimVersions)
    .set({ releasedAt: now, updatedAt: now })
    .where(eq(claimVersions.id, claim.currentVersionId!));
  await applyClaimEvent(tx, claim, 'release', {
    actor,
    versionId: claim.currentVersionId,
    payload: { via },
    now,
  });
  // Once a claim has left, the encounter's status belongs to Cleanpost (sync never downgrades it).
  await tx
    .update(encounters)
    .set({ status: 'claimed', updatedAt: now })
    .where(eq(encounters.id, claim.encounterId));
  await recordAudit(tx, {
    actor,
    action: 'claim.released',
    entityType: 'claim',
    entityId: claim.id,
    clientId: claim.clientId,
    metadata: { via, mode: claim.mode },
  });
}

export async function releaseClaim(
  deps: ReleaseDeps,
  ctx: { tenantId: string; claimId: string },
  actor: AuditActor = 'automation:claim.release',
): Promise<ReleaseOutcome> {
  const now = deps.now?.() ?? new Date();
  const loaded = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) => load(tx, ctx.claimId));
  if ('status' in loaded) return loaded;
  const { claim, conn, encounterExternalId } = loaded;
  const adapter = deps.registry.get(conn.adapterKey);
  const caps = await adapter.capabilities(conn).catch(() => null);
  const level = caps?.releaseCharge;

  if (level === 'unavailable') {
    await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) =>
      markReleased(tx, claim, 'pm_schedule', actor, now),
    );
    return { status: 'released', via: 'pm_schedule' };
  }
  // The adapter call happens outside any transaction.
  const res = await adapter.releaseCharge(conn, encounterExternalId);
  if (res.ok) {
    await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
      const [current] = await tx.select().from(claims).where(eq(claims.id, claim.id)).for('update');
      if (current && (current.status === 'ready' || current.status === 'corrected')) {
        await markReleased(tx, current, 'adapter', actor, now);
      }
    });
    return { status: 'released', via: 'adapter' };
  }
  if (res.manualTask) {
    const workItemId = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) =>
      ensureManualTask(tx, claim, conn, res.manualTask!, actor, now),
    );
    return { status: 'manual_task', workItemId };
  }
  deps.log.warn({ claimId: claim.id, code: res.code, retryable: res.retryable }, 'release failed');
  return { status: 'failed', code: res.code, retryable: res.retryable, message: res.message };
}

/**
 * After a claim is built, hold the charge in the PM so it does not bill before the scrub (docs/04).
 * Tebra encounters already wait in Review; a PM without hold gets nothing here.
 */
export async function holdCharges(
  deps: ReleaseDeps,
  ctx: { tenantId: string; claimIds: string[] },
): Promise<{ held: number; skipped: number; failed: number }> {
  const out = { held: 0, skipped: 0, failed: 0 };
  if (ctx.claimIds.length === 0) return out;
  const targets = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const rows = await tx.select().from(claims).where(inArray(claims.id, ctx.claimIds));
    const list: { claimId: string; conn: Connection; encounterExternalId: string }[] = [];
    for (const c of rows) {
      const t = await pmTarget(tx, c);
      if (t) list.push({ claimId: c.id, ...t });
    }
    return list;
  });
  for (const t of targets) {
    const adapter = deps.registry.get(t.conn.adapterKey);
    const caps = await adapter.capabilities(t.conn).catch(() => null);
    const level = caps?.holdCharge;
    if (typeof level !== 'number' || level === 0) {
      out.skipped++;
      continue;
    }
    const res = await adapter.holdCharge(t.conn, t.encounterExternalId);
    if (res.ok) out.held++;
    else {
      out.failed++;
      deps.log.warn({ claimId: t.claimId, code: res.code }, 'hold failed');
    }
  }
  return out;
}

/** A human approves a claim in review (W-10, C-11): needs_review -> ready, recorded with the user. */
export async function approveClaim(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_in_review' }> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim) return { ok: false, reason: 'not_found' };
    if (claim.status !== 'needs_review') return { ok: false, reason: 'not_in_review' };
    const actor: AuditActor = `user:${ctx.userId}`;
    await applyClaimEvent(tx, claim, 'approve', { actor, versionId: claim.currentVersionId });
    // The review item is done once the claim is approved.
    const open = await tx
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, claim.id),
          eq(workItems.type, 'claim_review'),
          ne(workItems.status, 'resolved'),
        ),
      );
    for (const item of open) {
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'resolve');
      if (!next.ok) continue;
      await tx
        .update(workItems)
        .set({
          status: next.value,
          resolvedBy: actor,
          resolution: 'Approved',
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workItems.id, item.id));
    }
    await recordAudit(tx, {
      actor,
      action: 'claim.approved',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
    });
    return { ok: true };
  });
}
