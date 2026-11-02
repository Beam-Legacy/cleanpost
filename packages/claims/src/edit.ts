/**
 * A person edits a claim before release (W-10 Apply fix, W-11 fix in place, C-08 editor).
 *
 * Each edit is a new claim version (claims are versioned, never edited in place; CLAUDE.md rule 4),
 * one `corrections` row per changed field (docs/08-work-queue.md), a claim event and an audit event.
 * In Mode A the PM is the system of record (docs/04-modes.md), so the change is written back with
 * `pushChargeCorrection`; where the PM cannot be written to, the biller gets one manual task with
 * a worksheet of every change, and the claim is not released until the PM shows the change.
 *
 * The caller re-scrubs the new version (in place for the panel, or through the claim.scrub job).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { ChargeCorrection, Connection } from '@cleanpost/adapters';
import {
  chargeLines,
  claims,
  claimVersions,
  connections,
  corrections,
  externalRefs,
  manualTasks,
  scrubResults,
  withAudit,
  withTenant,
  recordAudit,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import {
  applyFix,
  checkEdit,
  diffPayload,
  state,
  type ClaimPayload,
  type EditError,
  type Finding,
  type FixError,
  type PayloadChange,
} from '@cleanpost/domain';
import { insertVersion, lastPmVersion } from './versions';
import { applyClaimEvent } from './events';
import type { ReleaseDeps } from './release';
import { CORRECTION_OPERATION, ensureManualTask } from './tasks';

export type EditInput =
  /** Apply the suggested fixes of these findings on the current scrub, in order, as one version. */
  | { kind: 'fix'; ruleIds: string[] }
  /** The C-08 editor's whole payload. */
  | { kind: 'payload'; payload: ClaimPayload };

export type EditOutcome =
  | {
      status: 'edited';
      versionId: string;
      changes: PayloadChange[];
      /** Mode A write-back: pushed to the PM, a manual task for the biller, or nothing to write. */
      pm: 'pushed' | 'manual_task' | 'not_needed';
      manualWorkItemId?: string;
    }
  | {
      status: 'refused';
      reason: 'not_found' | 'not_editable' | 'stale' | 'no_fix' | FixError | EditError;
    };

/** Field names the adapter contract uses for a charge correction (docs/05-adapters.md). */
function pmField(fieldPath: string): string {
  return fieldPath
    .replace(/\.dxPointers$/, '.diagnosisPointers')
    .replace(/^facility\.placeOfService$/, 'placeOfService');
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

interface Saved {
  claim: typeof claims.$inferSelect;
  versionId: string;
  version: number;
  changes: PayloadChange[];
  /** Every difference from what the PM holds, for the manual worksheet. */
  sincePm: PayloadChange[];
  conn: Connection | null;
  encounterExternalId: string | null;
  lineRefs: Map<string, string>;
}

async function save(
  tx: Tx,
  ctx: { userId: string; claimId: string; workItemId?: string; expectedVersionId?: string },
  input: EditInput,
  now: Date,
): Promise<Saved | Extract<EditOutcome, { status: 'refused' }>> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
  if (!claim?.currentVersionId) return { status: 'refused', reason: 'not_found' };
  const from = claim.status as state.ClaimState;
  if (!state.isPreRelease(from) || !state.nextClaimState(from, 'edit').ok)
    return { status: 'refused', reason: 'not_editable' };
  if (ctx.expectedVersionId && ctx.expectedVersionId !== claim.currentVersionId)
    return { status: 'refused', reason: 'stale' };
  const [current] = await tx.select().from(claimVersions).where(eq(claimVersions.id, claim.currentVersionId));
  if (!current) return { status: 'refused', reason: 'not_found' };
  const before = current.payload as ClaimPayload;

  let next: { payload: ClaimPayload; changes: PayloadChange[] };
  if (input.kind === 'fix') {
    const [result] = current.scrubResultId
      ? await tx.select().from(scrubResults).where(eq(scrubResults.id, current.scrubResultId))
      : [];
    const items = ((result?.findings as { items?: Finding[] } | null)?.items ?? []) as Finding[];
    let payload = before;
    for (const ruleId of input.ruleIds) {
      const finding = items.find((f) => f.ruleId === ruleId && f.suggestedFix);
      if (!finding?.suggestedFix) return { status: 'refused', reason: 'no_fix' };
      const fixed = applyFix(payload, finding.suggestedFix, finding.lineNumbers);
      // A later fix may already be covered by an earlier one; only a real failure stops the edit.
      if (!fixed.ok && fixed.error === 'no_change') continue;
      if (!fixed.ok) return { status: 'refused', reason: fixed.error };
      payload = fixed.value.payload;
    }
    const changes = diffPayload(before, payload);
    if (!changes.length) return { status: 'refused', reason: 'no_change' };
    next = { payload, changes };
  } else {
    const checked = checkEdit(before, input.payload);
    if (!checked.ok) return { status: 'refused', reason: checked.error };
    const changes = diffPayload(before, checked.value);
    if (!changes.length) return { status: 'refused', reason: 'no_change' };
    next = { payload: checked.value, changes };
  }

  const version = current.version + 1;
  const versionId = await insertVersion(tx, claim, version, next.payload, actor);
  await tx
    .update(claims)
    .set({
      currentVersionId: versionId,
      totalChargeCents: next.payload.totalChargeCents,
      balanceCents: next.payload.totalChargeCents,
      updatedAt: now,
    })
    .where(eq(claims.id, claim.id));
  await applyClaimEvent(tx, claim, 'edit', {
    actor,
    versionId,
    payload: { reason: 'user_edit', fields: next.changes.map((c) => c.fieldPath) },
    now,
  });
  await tx.insert(corrections).values(
    next.changes.map((c) => ({
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
  await withAudit(
    tx,
    {
      actor,
      action: 'claim.edited',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: {
        version,
        fields: next.changes.map((c) => c.fieldPath),
        source: input.kind,
        ...(input.kind === 'fix' ? { ruleIds: input.ruleIds } : {}),
      },
    },
    async () => undefined,
  );

  // What the PM needs to match: everything that differs from the last version built from it.
  const pmVersion = await lastPmVersion(tx, claim.id);
  const sincePm = pmVersion ? diffPayload(pmVersion.payload as ClaimPayload, next.payload) : next.changes;
  const [connRow] = await tx
    .select()
    .from(connections)
    .where(eq(connections.clientId, claim.clientId))
    .limit(1);
  const [encRef] = connRow
    ? await tx
        .select({ externalId: externalRefs.externalId })
        .from(externalRefs)
        .where(
          and(
            eq(externalRefs.connectionId, connRow.id),
            eq(externalRefs.entityType, 'encounter'),
            eq(externalRefs.entityId, claim.encounterId),
          ),
        )
    : [];
  const ids = [...new Set(sincePm.map((c) => c.chargeLineId).filter((x): x is string => Boolean(x)))];
  const lines = ids.length
    ? await tx
        .select({ id: chargeLines.id, externalId: chargeLines.externalId })
        .from(chargeLines)
        .where(inArray(chargeLines.id, ids))
    : [];
  return {
    claim,
    versionId,
    version,
    changes: next.changes,
    sincePm,
    conn: connRow ? toConnection(connRow) : null,
    encounterExternalId: encRef?.externalId ?? null,
    lineRefs: new Map(lines.filter((l) => l.externalId).map((l) => [l.id, l.externalId!])),
  };
}

function correctionFor(saved: Saved, changes: PayloadChange[]): ChargeCorrection {
  return {
    encounterExternalId: saved.encounterExternalId!,
    changes: changes.map((c) => {
      const lineExternalId = c.chargeLineId ? saved.lineRefs.get(c.chargeLineId) : undefined;
      return {
        ...(lineExternalId ? { lineExternalId } : {}),
        field: pmField(c.fieldPath),
        from: c.before,
        to: c.after,
        reason: c.label,
      };
    }),
  };
}

/** Opens (or refreshes) the one correction task for this claim, with every change as its worksheet. */
async function correctionTask(
  tx: Tx,
  saved: Saved,
  spec: { title: string; instructions: string[] },
  actor: AuditActor,
  now: Date,
) {
  const worksheet = saved.sincePm.map((c) => `Worksheet: ${c.label}.`);
  const instructions = [...spec.instructions, ...worksheet];
  const workItemId = await ensureManualTask(
    tx,
    saved.claim,
    saved.conn!,
    { operation: CORRECTION_OPERATION, title: spec.title, instructions },
    actor,
    now,
  );
  await tx
    .update(manualTasks)
    .set({ instructions, payloadRef: `claim_version:${saved.versionId}`, updatedAt: now })
    .where(and(eq(manualTasks.workItemId, workItemId), eq(manualTasks.status, 'open')));
  return workItemId;
}

export async function editClaim(
  deps: ReleaseDeps,
  ctx: {
    tenantId: string;
    userId: string;
    claimId: string;
    workItemId?: string;
    expectedVersionId?: string;
  },
  input: EditInput,
): Promise<EditOutcome> {
  const now = deps.now?.() ?? new Date();
  const actor: AuditActor = `user:${ctx.userId}`;
  const saved = await withTenant(deps.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    save(tx, ctx, input, now),
  );
  if ('status' in saved) return saved;
  const done = (pm: 'pushed' | 'manual_task' | 'not_needed', manualWorkItemId?: string): EditOutcome => ({
    status: 'edited',
    versionId: saved.versionId,
    changes: saved.changes,
    pm,
    ...(manualWorkItemId ? { manualWorkItemId } : {}),
  });
  // Modes B and C send the claim from Cleanpost: the PM's charge is not what gets billed.
  if (saved.claim.mode !== 'A' || !saved.conn || !saved.encounterExternalId) return done('not_needed');

  const conn = saved.conn;
  const adapter = deps.registry.get(conn.adapterKey);
  // The adapter call happens outside any transaction.
  const res = await adapter.pushChargeCorrection(conn, correctionFor(saved, saved.changes));
  if (res.ok) {
    await withTenant(deps.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
      recordAudit(tx, {
        actor,
        action: 'claim.correction_pushed',
        entityType: 'claim',
        entityId: saved.claim.id,
        clientId: saved.claim.clientId,
        metadata: { version: saved.version, fields: saved.changes.map((c) => c.fieldPath) },
      }),
    );
    return done('pushed');
  }
  if (!res.manualTask) deps.log.warn({ claimId: saved.claim.id, code: res.code }, 'charge correction failed');
  const spec = res.manualTask ?? {
    title: 'Correct the charge in the PM',
    instructions: [
      'Cleanpost could not write this change to the PM.',
      'Open the encounter in the PM and make each change in the worksheet.',
      'Cleanpost releases the claim once the next sync shows the change.',
    ],
  };
  const workItemId = await withTenant(deps.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    correctionTask(tx, saved, spec, actor, now),
  );
  return done('manual_task', workItemId);
}
