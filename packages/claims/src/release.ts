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
import { resubmissionTask } from './correct';
import { applyClaimEvent } from './events';
import { correctionPending, ensureManualTask } from './tasks';

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
  // The latest approval decision for this version; an Undo (unapproved) cancels the approval.
  const [decided] = await tx
    .select({ actor: claimEvents.actor, type: claimEvents.type })
    .from(claimEvents)
    .where(
      and(
        eq(claimEvents.claimId, claim.id),
        eq(claimEvents.claimVersionId, claim.currentVersionId),
        inArray(claimEvents.type, ['approved', 'unapproved']),
      ),
    )
    .orderBy(desc(claimEvents.occurredAt))
    .limit(1);
  const approval = decided?.type === 'approved' ? decided : null;
  const allowed = state.canRelease({
    state: claim.status as state.ClaimState,
    decision: (result?.decision ?? null) as state.ScrubDecision | null,
    confidence: result?.confidence ?? null,
    threshold: settings?.autoReleaseThresholdOverride ?? client?.autoReleaseThreshold ?? 90,
    approvedBy: approval?.actor ?? null,
  });
  if (!allowed.ok) return { status: 'refused', reason: allowed.error };
  if (await correctionPending(tx, claim.id)) return { status: 'refused', reason: 'pm_correction_pending' };
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
  // A claim that was ready leaves by release; one still in review, blocked or held left without it.
  await applyClaimEvent(
    tx,
    claim,
    claim.status === 'ready' || claim.status === 'corrected' ? 'release' : 'billed_outside',
    {
      actor,
      versionId: claim.currentVersionId,
      payload: { via },
      now,
    },
  );
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
  // A corrected claim (frequency 7) is resubmitted from the PM by a person (none of the PMs takes a
  // replacement claim through its API): a task with the changes and the original claim number.
  const correction = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [v] = await tx
      .select({ frequencyCode: claimVersions.frequencyCode })
      .from(claimVersions)
      .where(eq(claimVersions.id, claim.currentVersionId!));
    if (v?.frequencyCode !== '7') return null;
    return resubmissionTask(tx, {
      claim,
      connectionId: conn.id,
      pmName: (conn.settings.pmName as string | undefined) ?? 'the PM',
      encounterExternalId,
      actor,
      now,
    });
  });
  if (correction) return { status: 'manual_task', workItemId: correction };
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

/**
 * Undo of an approval within its 10 seconds (docs/09-ui-screens.md): ready -> needs_review, and the
 * review item opens again. Refused once the version has been released.
 */
export async function unapproveClaim(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_released' | 'not_approved' }> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim?.currentVersionId) return { ok: false, reason: 'not_found' };
    if (claim.status !== 'ready') {
      return {
        ok: false,
        reason: state.isPreRelease(claim.status as state.ClaimState) ? 'not_approved' : 'already_released',
      };
    }
    const actor: AuditActor = `user:${ctx.userId}`;
    await applyClaimEvent(tx, claim, 'unapprove', { actor, versionId: claim.currentVersionId });
    const [item] = await tx
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, claim.id),
          eq(workItems.type, 'claim_review'),
          eq(workItems.status, 'resolved'),
          eq(workItems.resolvedBy, actor),
        ),
      )
      .orderBy(desc(workItems.resolvedAt))
      .limit(1);
    if (item) {
      const next = state.nextWorkItemState('resolved', 'reopen');
      if (next.ok)
        await tx
          .update(workItems)
          .set({
            status: next.value,
            resolvedBy: null,
            resolution: null,
            resolvedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(workItems.id, item.id));
    }
    await recordAudit(tx, {
      actor,
      action: 'claim.approval_undone',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
    });
    return { ok: true };
  });
}

export const VOID_REASONS = [
  'Duplicate',
  'Entered in error',
  'Patient will pay',
  'Not billable',
  'Other',
] as const;

/**
 * C-13 for a claim that was never sent: draft to ready -> voided, with the reason, and its open
 * work items close. A claim the payer has (submitted or later) needs a void claim (frequency 8),
 * which goes with corrections in M4.
 */
export async function voidClaim(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; reason: string; note?: string | null },
): Promise<
  { ok: true } | { ok: false; reason: 'not_found' | 'already_sent' | 'note_required' | 'unknown_reason' }
> {
  if (!(VOID_REASONS as readonly string[]).includes(ctx.reason))
    return { ok: false, reason: 'unknown_reason' };
  if (ctx.reason === 'Other' && !ctx.note?.trim()) return { ok: false, reason: 'note_required' };
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim) return { ok: false, reason: 'not_found' };
    if (!state.isPreRelease(claim.status as state.ClaimState)) return { ok: false, reason: 'already_sent' };
    const actor: AuditActor = `user:${ctx.userId}`;
    const now = new Date();
    await applyClaimEvent(tx, claim, 'void', {
      actor,
      versionId: claim.currentVersionId,
      payload: { reason: ctx.reason, ...(ctx.note?.trim() ? { note: ctx.note.trim() } : {}) },
      now,
    });
    const open = await tx
      .select()
      .from(workItems)
      .where(and(eq(workItems.claimId, claim.id), ne(workItems.status, 'resolved')));
    for (const item of open) {
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
      if (!next.ok) continue;
      await tx
        .update(workItems)
        .set({
          status: next.value,
          resolvedBy: actor,
          resolution: 'Claim voided',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(workItems.id, item.id));
    }
    await recordAudit(tx, {
      actor,
      action: 'claim.voided',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { reason: ctx.reason, itemsClosed: open.length },
    });
    return { ok: true };
  });
}

/** C-16: a note on the claim timeline. Append-only; the text stays out of the audit metadata. */
export async function addClaimNote(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; text: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'empty' }> {
  const text = ctx.text.trim();
  if (!text) return { ok: false, reason: 'empty' };
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId));
    if (!claim) return { ok: false, reason: 'not_found' };
    const actor: AuditActor = `user:${ctx.userId}`;
    await tx.insert(claimEvents).values({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      claimId: claim.id,
      claimVersionId: claim.currentVersionId,
      type: 'note',
      payload: { text: text.slice(0, 2000) },
      actor,
    });
    await recordAudit(tx, {
      actor,
      action: 'claim.note_added',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { length: text.length },
    });
    return { ok: true };
  });
}

export const HOLD_REASONS = [
  'Waiting for records',
  'Waiting for prior authorization',
  'Waiting for coverage information',
  'Provider credentialing',
  'Other',
] as const;

/**
 * C-12: hold a claim that has not been sent until something it needs arrives. Its open review or
 * blocked item is snoozed until then (at most 30 days); the hold itself stays until released.
 */
export async function holdClaim(
  db: Database,
  ctx: {
    tenantId: string;
    userId: string;
    claimId: string;
    reason: string;
    until?: string | null;
    note?: string | null;
    now?: Date;
  },
): Promise<
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_holdable' | 'unknown_reason' | 'note_required' | 'past_deadline' }
> {
  if (!(HOLD_REASONS as readonly string[]).includes(ctx.reason))
    return { ok: false, reason: 'unknown_reason' };
  if (ctx.reason === 'Other' && !ctx.note?.trim()) return { ok: false, reason: 'note_required' };
  const now = ctx.now ?? new Date();
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim) return { ok: false, reason: 'not_found' };
    if (!state.nextClaimState(claim.status as state.ClaimState, 'hold').ok)
      return { ok: false, reason: 'not_holdable' };
    // Holding past the filing deadline less 14 days would risk a timely-filing denial.
    if (ctx.until && claim.filingDeadline) {
      const latest = new Date(Date.parse(`${claim.filingDeadline}T00:00:00Z`) - 14 * 86_400_000);
      if (Date.parse(`${ctx.until}T00:00:00Z`) > latest.getTime())
        return { ok: false, reason: 'past_deadline' };
    }
    const actor: AuditActor = `user:${ctx.userId}`;
    await applyClaimEvent(tx, claim, 'hold', {
      actor,
      versionId: claim.currentVersionId,
      payload: {
        reason: ctx.reason,
        ...(ctx.until ? { until: ctx.until } : {}),
        ...(ctx.note?.trim() ? { note: ctx.note.trim() } : {}),
      },
      now,
    });
    const wake = new Date(
      Math.min(
        ctx.until ? Date.parse(`${ctx.until}T15:00:00Z`) : Number.POSITIVE_INFINITY,
        now.getTime() + 30 * 86_400_000,
      ),
    );
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
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'snooze');
      if (!next.ok) continue;
      await tx
        .update(workItems)
        .set({ status: next.value, snoozedUntil: wake, updatedAt: now })
        .where(eq(workItems.id, item.id));
    }
    await recordAudit(tx, {
      actor,
      action: 'claim.held',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { reason: ctx.reason, until: ctx.until ?? null },
    });
    return { ok: true };
  });
}

/** C-12 Release hold: back to built; the caller queues a fresh scrub of the current version. */
export async function releaseHold(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
): Promise<{ ok: true; versionId: string } | { ok: false; reason: 'not_found' | 'not_on_hold' }> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim?.currentVersionId) return { ok: false, reason: 'not_found' };
    if (claim.status !== 'on_hold') return { ok: false, reason: 'not_on_hold' };
    const actor: AuditActor = `user:${ctx.userId}`;
    await applyClaimEvent(tx, claim, 'unhold', { actor, versionId: claim.currentVersionId });
    await recordAudit(tx, {
      actor,
      action: 'claim.hold_released',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
    });
    return { ok: true, versionId: claim.currentVersionId };
  });
}
