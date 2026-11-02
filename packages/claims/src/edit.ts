/**
 * A person edits a claim before release (W-10 Apply fix, W-11 fix in place, C-08 editor).
 *
 * `editClaim` (database only, called from the web app): each edit is a new claim version (claims
 * are versioned, never edited in place; CLAUDE.md rule 4), one `corrections` row per changed field
 * (docs/08-work-queue.md), a claim event and an audit event. In Mode A it also records that the PM
 * must get the change (`correction_requested`); the caller queues `claim.correct`.
 *
 * `pushCorrection` (the `claim.correct` job, in the worker, which alone talks to PMs): writes
 * everything the PM does not have yet with `pushChargeCorrection`. Where the PM cannot be written
 * to, the biller gets one correction task with a worksheet of every change since the last version
 * read from the PM. Release waits for either (`correctionPending`).
 *
 * The caller re-scrubs the new version (in place for the panel, or through the claim.scrub job).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AdapterRegistry, ChargeCorrection, Connection } from '@cleanpost/adapters';
import {
  chargeLines,
  claimEvents,
  claims,
  claimVersions,
  connections,
  corrections,
  externalRefs,
  manualTasks,
  recordAudit,
  scrubResults,
  withAudit,
  withTenant,
  type AuditActor,
  type Database,
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
import type { Logger } from '@cleanpost/log';
import { applyClaimEvent, recordClaimEvent } from './events';
import { CORRECTION_EVENTS, CORRECTION_OPERATION, ensureManualTask } from './tasks';
import { insertVersion, lastPmVersion } from './versions';

export type EditInput =
  /** Apply the suggested fixes of these findings on the current scrub, in order, as one version. */
  | { kind: 'fix'; ruleIds: string[] }
  /** The C-08 editor's whole payload. */
  | { kind: 'payload'; payload: ClaimPayload };

export type EditOutcome =
  | {
      status: 'edited';
      versionId: string;
      version: number;
      changes: PayloadChange[];
      /** Mode A: the PM must get this change; queue `claim.correct`. */
      writeBack: boolean;
    }
  | {
      status: 'refused';
      reason: 'not_found' | 'not_editable' | 'stale' | 'no_fix' | FixError | EditError;
    };

type Refused = Extract<EditOutcome, { status: 'refused' }>;

async function nextPayload(
  tx: Tx,
  current: typeof claimVersions.$inferSelect,
  input: EditInput,
): Promise<{ payload: ClaimPayload; changes: PayloadChange[] } | Refused> {
  const before = current.payload as ClaimPayload;
  if (input.kind === 'payload') {
    const checked = checkEdit(before, input.payload);
    if (!checked.ok) return { status: 'refused', reason: checked.error };
    const changes = diffPayload(before, checked.value);
    if (!changes.length) return { status: 'refused', reason: 'no_change' };
    return { payload: checked.value, changes };
  }
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
  return { payload, changes };
}

export async function editClaim(
  db: Database,
  ctx: {
    tenantId: string;
    userId: string;
    claimId: string;
    workItemId?: string;
    /** The version the person was looking at; another edit since then refuses as `stale`. */
    expectedVersionId?: string;
  },
  input: EditInput,
  opts: { now?: Date } = {},
): Promise<EditOutcome> {
  const now = opts.now ?? new Date();
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
    if (!claim?.currentVersionId) return { status: 'refused', reason: 'not_found' };
    const from = claim.status as state.ClaimState;
    if (!state.isPreRelease(from) || !state.nextClaimState(from, 'edit').ok)
      return { status: 'refused', reason: 'not_editable' };
    if (ctx.expectedVersionId && ctx.expectedVersionId !== claim.currentVersionId)
      return { status: 'refused', reason: 'stale' };
    const [current] = await tx
      .select()
      .from(claimVersions)
      .where(eq(claimVersions.id, claim.currentVersionId));
    if (!current) return { status: 'refused', reason: 'not_found' };
    const next = await nextPayload(tx, current, input);
    if ('status' in next) return next;

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
    const fields = next.changes.map((c) => c.fieldPath);
    await applyClaimEvent(tx, claim, 'edit', {
      actor,
      versionId,
      payload: { reason: 'user_edit', fields },
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
          fields,
          source: input.kind,
          ...(input.kind === 'fix' ? { ruleIds: input.ruleIds } : {}),
        },
      },
      async () => undefined,
    );
    // Modes B and C send the claim from Cleanpost: the PM's charge is not what gets billed.
    const [conn] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.clientId, claim.clientId))
      .limit(1);
    const writeBack = claim.mode === 'A' && Boolean(conn);
    if (writeBack) {
      await recordClaimEvent(tx, claim, CORRECTION_EVENTS.requested, {
        actor,
        versionId,
        payload: { version, fields },
        now,
      });
    }
    return { status: 'edited', versionId, version, changes: next.changes, writeBack };
  });
}

// ---------- claim.correct: write the change to the PM ----------

export interface CorrectionDeps {
  db: Database;
  registry: AdapterRegistry;
  log: Logger;
  now?: () => Date;
}

export type CorrectionOutcome =
  | { status: 'pushed'; version: number }
  | { status: 'manual_task'; workItemId: string; version: number }
  | { status: 'not_needed'; reason: 'not_found' | 'not_mode_a' | 'no_connection' | 'up_to_date' };

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

interface CorrectionPlan {
  claim: typeof claims.$inferSelect;
  version: typeof claimVersions.$inferSelect;
  /** What the PM is missing: changes since the last version it is known to hold. */
  toPush: PayloadChange[];
  /** Every difference from the last version read from the PM, for a manual worksheet. */
  sincePm: PayloadChange[];
  conn: Connection;
  encounterExternalId: string;
  lineRefs: Map<string, string>;
}

/** The version the PM holds: the later of the last one read from it and the last one pushed to it. */
async function pmHolds(tx: Tx, claimId: string) {
  const fromPm = await lastPmVersion(tx, claimId);
  const [pushed] = await tx
    .select({ version: sql<number>`(${claimEvents.payload}->>'version')::int` })
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, CORRECTION_EVENTS.pushed)))
    .orderBy(desc(sql`(${claimEvents.payload}->>'version')::int`))
    .limit(1);
  if (!pushed || (fromPm && fromPm.version >= pushed.version)) return fromPm;
  const [v] = await tx
    .select()
    .from(claimVersions)
    .where(and(eq(claimVersions.claimId, claimId), eq(claimVersions.version, pushed.version)));
  return v ?? fromPm;
}

async function plan(tx: Tx, claimId: string): Promise<CorrectionPlan | CorrectionOutcome> {
  const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId));
  if (!claim?.currentVersionId) return { status: 'not_needed', reason: 'not_found' };
  if (claim.mode !== 'A') return { status: 'not_needed', reason: 'not_mode_a' };
  const [version] = await tx.select().from(claimVersions).where(eq(claimVersions.id, claim.currentVersionId));
  if (!version) return { status: 'not_needed', reason: 'not_found' };
  const payload = version.payload as ClaimPayload;
  const holds = await pmHolds(tx, claim.id);
  const toPush = holds ? diffPayload(holds.payload as ClaimPayload, payload) : [];
  const fromPm = await lastPmVersion(tx, claim.id);
  const sincePm = fromPm ? diffPayload(fromPm.payload as ClaimPayload, payload) : toPush;
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
  if (!connRow || !encRef) return { status: 'not_needed', reason: 'no_connection' };
  const ids = [...new Set(sincePm.map((c) => c.chargeLineId).filter((x): x is string => Boolean(x)))];
  const lines = ids.length
    ? await tx
        .select({ id: chargeLines.id, externalId: chargeLines.externalId })
        .from(chargeLines)
        .where(inArray(chargeLines.id, ids))
    : [];
  return {
    claim,
    version,
    toPush,
    sincePm,
    conn: toConnection(connRow),
    encounterExternalId: encRef.externalId,
    lineRefs: new Map(lines.filter((l) => l.externalId).map((l) => [l.id, l.externalId!])),
  };
}

function correctionFor(p: CorrectionPlan): ChargeCorrection {
  return {
    encounterExternalId: p.encounterExternalId,
    changes: p.toPush.map((c) => {
      const lineExternalId = c.chargeLineId ? p.lineRefs.get(c.chargeLineId) : undefined;
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

const ACTOR: AuditActor = 'automation:claim.correct';

export async function pushCorrection(
  deps: CorrectionDeps,
  ctx: { tenantId: string; claimId: string },
): Promise<CorrectionOutcome> {
  const now = deps.now?.() ?? new Date();
  const p = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) => plan(tx, ctx.claimId));
  if ('status' in p) return p;
  const markPushed = (tx: Tx) =>
    recordClaimEvent(tx, p.claim, CORRECTION_EVENTS.pushed, {
      actor: ACTOR,
      versionId: p.version.id,
      payload: { version: p.version.version, fields: p.toPush.map((c) => c.fieldPath) },
      now,
    });
  if (!p.toPush.length) {
    // The PM already holds this version (an edit was undone, or the PM changed to match).
    await withTenant(deps.db, { tenantId: ctx.tenantId }, markPushed);
    return { status: 'not_needed', reason: 'up_to_date' };
  }

  const adapter = deps.registry.get(p.conn.adapterKey);
  // The adapter call happens outside any transaction.
  const res = await adapter.pushChargeCorrection(p.conn, correctionFor(p));
  if (res.ok) {
    await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
      await markPushed(tx);
      await recordAudit(tx, {
        actor: ACTOR,
        action: 'claim.correction_pushed',
        entityType: 'claim',
        entityId: p.claim.id,
        clientId: p.claim.clientId,
        metadata: { version: p.version.version, fields: p.toPush.map((c) => c.fieldPath) },
      });
    });
    return { status: 'pushed', version: p.version.version };
  }
  if (!res.manualTask) deps.log.warn({ claimId: p.claim.id, code: res.code }, 'charge correction failed');
  const spec = res.manualTask ?? {
    title: 'Correct the charge in the PM',
    instructions: [
      'Cleanpost could not write this change to the PM.',
      'Open the encounter in the PM and make each change in the worksheet.',
      'Cleanpost releases the claim once the next sync shows the change.',
    ],
  };
  const workItemId = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const instructions = [...spec.instructions, ...p.sincePm.map((c) => `Worksheet: ${c.label}.`)];
    const id = await ensureManualTask(
      tx,
      p.claim,
      p.conn,
      { operation: CORRECTION_OPERATION, title: spec.title, instructions },
      ACTOR,
      now,
    );
    // One task per claim: later edits refresh its worksheet.
    await tx
      .update(manualTasks)
      .set({ instructions, payloadRef: `claim_version:${p.version.id}`, updatedAt: now })
      .where(and(eq(manualTasks.workItemId, id), eq(manualTasks.status, 'open')));
    await recordClaimEvent(tx, p.claim, CORRECTION_EVENTS.manual, {
      actor: ACTOR,
      versionId: p.version.id,
      payload: { version: p.version.version, workItemId: id },
      now,
    });
    return id;
  });
  return { status: 'manual_task', workItemId, version: p.version.version };
}
