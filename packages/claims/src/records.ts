/**
 * P-02 coverage and P-06 patient corrections, and the W-13 eligibility actions (DEC-30).
 *
 * The PM stays the system of record and the adapter contract has no patient or coverage write, so a
 * correction is saved in Cleanpost (source `user`), recorded field by field in `corrections`, and
 * turned into one task per patient to make the same change in the PM. Claims for the patient are
 * scrubbed again at once (the biller sees whether the fix works with the payer), but none is
 * released while the PM still shows the old values (`recordPending`); the sync closes the task when
 * the PM catches up (packages/sync).
 */
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  claims,
  claimVersions,
  connections,
  corrections,
  coverages,
  decryptField,
  eligibilityChecks,
  encryptField,
  last4,
  manualTasks,
  patients,
  payers,
  recordAudit,
  withAudit,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { records, state, type ClaimPayload } from '@cleanpost/domain';
import { now as clockNow } from '@cleanpost/clock';
import { applyClaimEvent } from './events';
import { voidClaim } from './release';
import { insertVersion } from './versions';

export { recordPending } from './tasks';

async function pmConnection(tx: Tx, clientId: string) {
  const [conn] = await tx.select().from(connections).where(eq(connections.clientId, clientId)).limit(1);
  if (!conn) return null;
  return { id: conn.id, pmName: ((conn.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM' };
}

/**
 * One open task (manual_task work item) per patient and operation. A second correction joins the
 * first task; its text is rewritten from every field corrected under it.
 */
async function ensurePatientTask(
  tx: Tx,
  p: { tenantId: string; clientId: string; patientId: string; claimId?: string | null },
  conn: { id: string },
  operation: string,
  spec: (fields: string[]) => { title: string; instructions: string[] },
  fields: string[],
  actor: AuditActor,
  now: Date,
): Promise<string> {
  const [open] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.patientId, p.patientId),
        eq(workItems.type, 'manual_task'),
        eq(workItems.reasonCode, operation),
        ne(workItems.status, 'resolved'),
      ),
    );
  if (open) {
    const earlier = await tx
      .selectDistinct({ field: corrections.fieldPath })
      .from(corrections)
      .where(eq(corrections.workItemId, open.id));
    const all = [...new Set([...earlier.map((e) => e.field.split('.').at(-1)!), ...fields])];
    const text = spec(all);
    await tx.update(workItems).set({ summary: text.title, updatedAt: now }).where(eq(workItems.id, open.id));
    await tx
      .update(manualTasks)
      .set({ title: text.title, instructions: text.instructions, updatedAt: now })
      .where(eq(manualTasks.workItemId, open.id));
    return open.id;
  }
  const text = spec(fields);
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: p.tenantId,
      clientId: p.clientId,
      type: 'manual_task',
      priority: 2,
      dueAt: new Date(now.getTime() + 24 * 3_600_000),
      patientId: p.patientId,
      claimId: p.claimId ?? null,
      connectionId: conn.id,
      reasonCode: operation,
      summary: text.title,
    })
    .returning({ id: workItems.id });
  await tx.insert(manualTasks).values({
    tenantId: p.tenantId,
    clientId: p.clientId,
    connectionId: conn.id,
    operation,
    workItemId: item!.id,
    title: text.title,
    instructions: text.instructions,
  });
  await recordAudit(tx, {
    actor,
    action: 'manual_task.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: p.clientId,
    metadata: { operation, patientId: p.patientId },
  });
  return item!.id;
}

/**
 * Claims for this patient (or coverage) that have not gone out, moved back to `built` so the scrub
 * runs again with the corrected record. Returns the versions to scrub.
 */
async function backToBuilt(
  tx: Tx,
  where: { coverageId: string } | { patientId: string },
  actor: AuditActor,
  now: Date,
  reason: string,
  statuses: readonly string[] = ['blocked', 'needs_review'],
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(claims)
    .where(
      and(
        'coverageId' in where
          ? eq(claims.coverageId, where.coverageId)
          : eq(claims.patientId, where.patientId),
        inArray(claims.status, [...statuses, 'built']),
      ),
    )
    .for('update');
  const out: string[] = [];
  for (const c of rows) {
    if (!c.currentVersionId) continue;
    if (c.status !== 'built') {
      await applyClaimEvent(tx, c, c.status === 'blocked' ? 'fix' : 'edit', {
        actor,
        versionId: c.currentVersionId,
        payload: { reason },
        now,
      });
    }
    out.push(c.currentVersionId);
  }
  return out;
}

/** Re-scrub after a new eligibility answer (W-13 Check again, P-01): versions to scrub. */
export async function rescrubForCoverage(
  db: Database,
  ctx: { tenantId: string; userId: string; coverageId: string },
): Promise<string[]> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    backToBuilt(tx, { coverageId: ctx.coverageId }, `user:${ctx.userId}`, clockNow(), 'eligibility_checked'),
  );
}

export type RecordEditRefusal = 'not_found' | 'no_change' | 'invalid' | 'no_connection';
export type RecordEditOutcome =
  | { ok: true; fields: string[]; pmName: string; taskItemId: string; versionIds: string[] }
  | { ok: false; reason: RecordEditRefusal; field?: string; message?: string };

const COVERAGE_FIELDS = [
  'payerId',
  'memberId',
  'groupNumber',
  'relationship',
  'priority',
  'effectiveDate',
  'terminationDate',
] as const;

/** P-02 (and P-05 Confirm card): correct a coverage in Cleanpost and ask the PM to follow. */
export async function editCoverage(
  db: Database,
  ctx: {
    tenantId: string;
    userId: string;
    coverageId: string;
    edit: records.CoverageEdit;
    /** card when the values came from a confirmed card (P-05). */
    source?: 'user' | 'card';
    now?: Date;
  },
): Promise<RecordEditOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const now = ctx.now ?? clockNow();
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [cov] = await tx.select().from(coverages).where(eq(coverages.id, ctx.coverageId)).for('update');
    if (!cov) return { ok: false, reason: 'not_found' };
    const [payer] = await tx.select().from(payers).where(eq(payers.id, ctx.edit.payerId));
    if (!payer) return { ok: false, reason: 'invalid', field: 'payerId', message: 'Choose a payer.' };
    const newMember = ctx.edit.memberId?.trim() ? ctx.edit.memberId.trim().toUpperCase() : null;
    if (newMember) {
      const problem = records.memberIdProblem(newMember, payer.name);
      if (problem) return { ok: false, reason: 'invalid', field: 'memberId', message: problem };
    }
    const oldMember = decryptField(cov.memberIdEncrypted);
    const before = {
      payerId: cov.payerId,
      memberId: oldMember,
      groupNumber: cov.groupNumber,
      relationship: cov.relationship,
      priority: cov.priority,
      effectiveDate: cov.effectiveDate,
      terminationDate: cov.terminationDate,
    };
    const after = {
      payerId: payer.id,
      memberId: newMember ?? oldMember,
      groupNumber: ctx.edit.groupNumber?.trim() || null,
      relationship: ctx.edit.relationship,
      priority: ctx.edit.priority,
      effectiveDate: ctx.edit.effectiveDate || null,
      terminationDate: ctx.edit.terminationDate || null,
    };
    const fields = records.changedFields(before, after, COVERAGE_FIELDS);
    if (!fields.length) return { ok: false, reason: 'no_change' };
    const conn = await pmConnection(tx, cov.clientId);
    if (!conn) return { ok: false, reason: 'no_connection' };

    const source = ctx.source ?? 'user';
    // Changing the order swaps with the coverage that had it (P-02 "reorders other coverages").
    if (fields.includes('priority')) {
      await tx
        .update(coverages)
        .set({ priority: cov.priority, source, updatedAt: now })
        .where(
          and(
            eq(coverages.patientId, cov.patientId),
            eq(coverages.priority, after.priority),
            ne(coverages.id, cov.id),
          ),
        );
    }
    await withAudit(
      tx,
      {
        actor,
        action: 'coverage.updated',
        entityType: 'coverage',
        entityId: cov.id,
        clientId: cov.clientId,
        metadata: { fields, via: source === 'card' ? 'P-05' : 'P-02' },
      },
      () =>
        tx
          .update(coverages)
          .set({
            payerId: after.payerId,
            payerName: payer.name,
            groupNumber: after.groupNumber,
            relationship: after.relationship,
            priority: after.priority,
            effectiveDate: after.effectiveDate,
            terminationDate: after.terminationDate,
            ...(fields.includes('memberId')
              ? { memberIdEncrypted: encryptField(after.memberId), memberIdLast4: last4(after.memberId) }
              : {}),
            source,
            updatedAt: now,
          })
          .where(eq(coverages.id, cov.id)),
    );
    const payerLabel = fields.includes('payerId') ? cov.payerName : payer.name;
    const taskItemId = await ensurePatientTask(
      tx,
      { tenantId: cov.tenantId, clientId: cov.clientId, patientId: cov.patientId },
      conn,
      records.UPDATE_COVERAGE,
      (f) => records.coverageTask({ payer: payerLabel, fields: f, pmName: conn.pmName }),
      fields,
      actor,
      now,
    );
    // Values stay in the database; member IDs encrypted like the coverage's own.
    const val = (f: string, v: unknown) =>
      f === 'memberId' && v ? { encrypted: encryptField(String(v)) } : (v ?? null);
    await tx.insert(corrections).values(
      fields.map((f) => ({
        tenantId: cov.tenantId,
        clientId: cov.clientId,
        workItemId: taskItemId,
        entityType: 'coverage',
        entityId: cov.id,
        fieldPath: `coverage.${f}`,
        before: val(f, before[f]),
        after: val(f, after[f]),
        userId: ctx.userId,
      })),
    );

    // A new payer changes the claims on this coverage: a new version each, scrubbed again.
    const versionIds: string[] = [];
    if (fields.includes('payerId')) {
      const open = await tx
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.coverageId, cov.id),
            inArray(claims.status, ['built', 'needs_review', 'blocked', 'ready']),
          ),
        )
        .for('update');
      for (const c of open) {
        if (!c.currentVersionId) continue;
        const [v] = await tx.select().from(claimVersions).where(eq(claimVersions.id, c.currentVersionId));
        if (!v) continue;
        const payload = { ...(v.payload as ClaimPayload), payerId: payer.id, payerName: payer.name };
        const versionId = await insertVersion(tx, c, v.version + 1, payload, actor);
        await tx
          .update(claims)
          .set({ currentVersionId: versionId, payerId: payer.id, updatedAt: now })
          .where(eq(claims.id, c.id));
        if (c.status !== 'built')
          await applyClaimEvent(tx, c, c.status === 'blocked' ? 'fix' : 'edit', {
            actor,
            versionId,
            payload: { reason: 'coverage_corrected' },
            now,
          });
        versionIds.push(versionId);
      }
    }
    return { ok: true, fields, pmName: conn.pmName, taskItemId, versionIds };
  });
}

const PATIENT_FIELDS = ['firstName', 'lastName', 'dob', 'sex', 'address', 'phone'] as const;

/** P-06: correct a patient's details in Cleanpost and ask the PM to follow. */
export async function editPatient(
  db: Database,
  ctx: { tenantId: string; userId: string; patientId: string; edit: records.PatientEdit; now?: Date },
): Promise<RecordEditOutcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const now = ctx.now ?? clockNow();
  const problem = records.dobProblem(ctx.edit.dob, now.toISOString().slice(0, 10));
  if (problem) return { ok: false, reason: 'invalid', field: 'dob', message: problem };
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [p] = await tx.select().from(patients).where(eq(patients.id, ctx.patientId)).for('update');
    if (!p) return { ok: false, reason: 'not_found' };
    const address = ctx.edit.address
      ? Object.fromEntries(Object.entries(ctx.edit.address).filter(([, v]) => v))
      : null;
    const before = {
      firstName: p.firstName,
      lastName: p.lastName,
      dob: p.dob,
      sex: p.sex,
      address: p.address,
      phone: p.phone,
    };
    const after = {
      firstName: ctx.edit.firstName,
      lastName: ctx.edit.lastName,
      dob: ctx.edit.dob,
      sex: ctx.edit.sex,
      address: address && Object.keys(address).length ? address : null,
      phone: ctx.edit.phone || null,
    };
    const fields = records.changedFields(before, after, PATIENT_FIELDS);
    if (!fields.length) return { ok: false, reason: 'no_change' };
    const conn = await pmConnection(tx, p.clientId);
    if (!conn) return { ok: false, reason: 'no_connection' };
    await withAudit(
      tx,
      {
        actor,
        action: 'patient.updated',
        entityType: 'patient',
        entityId: p.id,
        clientId: p.clientId,
        metadata: { fields, via: 'P-06' },
      },
      () =>
        tx
          .update(patients)
          .set({ ...after, source: 'user', updatedAt: now })
          .where(eq(patients.id, p.id)),
    );
    const taskItemId = await ensurePatientTask(
      tx,
      { tenantId: p.tenantId, clientId: p.clientId, patientId: p.id },
      conn,
      records.UPDATE_PATIENT,
      (f) => records.patientTask({ fields: f, pmName: conn.pmName }),
      fields,
      actor,
      now,
    );
    await tx.insert(corrections).values(
      fields.map((f) => ({
        tenantId: p.tenantId,
        clientId: p.clientId,
        workItemId: taskItemId,
        entityType: 'patient',
        entityId: p.id,
        fieldPath: `patient.${f}`,
        before: (before[f] ?? null) as unknown,
        after: (after[f] ?? null) as unknown,
        userId: ctx.userId,
      })),
    );
    const versionIds = await backToBuilt(tx, { patientId: p.id }, actor, now, 'patient_corrected');
    return { ok: true, fields, pmName: conn.pmName, taskItemId, versionIds };
  });
}

/** The latest eligibility answer for each of the patient's coverages. */
export async function latestChecks(tx: Tx, patientId: string) {
  const covs = await tx.select().from(coverages).where(eq(coverages.patientId, patientId));
  const out = new Map<string, typeof eligibilityChecks.$inferSelect>();
  for (const c of covs) {
    const [chk] = await tx
      .select()
      .from(eligibilityChecks)
      .where(eq(eligibilityChecks.coverageId, c.id))
      .orderBy(desc(eligibilityChecks.requestedAt))
      .limit(1);
    if (chk) out.set(c.id, chk);
  }
  return { coverages: covs, checks: out };
}

export type W13Outcome =
  | { ok: true; pmName: string }
  | { ok: false; reason: 'not_found' | 'not_active' | 'already_sent' | 'no_connection' };

/**
 * W-13 Use other coverage: in Mode A the PM decides which insurance a visit bills, so this is a
 * task to switch it there; the claim stays blocked until the sync shows the new payer.
 */
export async function useOtherCoverage(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; coverageId: string; now?: Date },
): Promise<W13Outcome> {
  const actor: AuditActor = `user:${ctx.userId}`;
  const now = ctx.now ?? clockNow();
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId));
    if (!claim) return { ok: false, reason: 'not_found' };
    if (!state.isPreRelease(claim.status as state.ClaimState)) return { ok: false, reason: 'already_sent' };
    const [row] = await tx
      .select({ cov: coverages, patient: patients })
      .from(coverages)
      .innerJoin(patients, eq(patients.id, coverages.patientId))
      .where(and(eq(coverages.id, ctx.coverageId), eq(coverages.patientId, claim.patientId)));
    if (!row) return { ok: false, reason: 'not_found' };
    const [chk] = await tx
      .select({ status: eligibilityChecks.status })
      .from(eligibilityChecks)
      .where(eq(eligibilityChecks.coverageId, row.cov.id))
      .orderBy(desc(eligibilityChecks.requestedAt))
      .limit(1);
    if (chk?.status !== 'active') return { ok: false, reason: 'not_active' };
    const conn = await pmConnection(tx, claim.clientId);
    if (!conn) return { ok: false, reason: 'no_connection' };
    await ensurePatientTask(
      tx,
      { tenantId: claim.tenantId, clientId: claim.clientId, patientId: claim.patientId, claimId: claim.id },
      conn,
      records.CHANGE_VISIT_COVERAGE,
      () => ({
        title: `Bill ${row.cov.payerName} for this visit in ${conn.pmName}`,
        instructions: [
          `In ${conn.pmName}, make this patient's ${row.cov.payerName} coverage the insurance for the visit (or the primary).`,
          `The claim is built again with ${row.cov.payerName} on the next sync, and this closes itself.`,
        ],
      }),
      [],
      actor,
      now,
    );
    await recordAudit(tx, {
      actor,
      action: 'claim.other_coverage_requested',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { coverageId: row.cov.id },
    });
    return { ok: true, pmName: conn.pmName };
  });
}

/**
 * W-13 Mark self-pay: the claim is voided ("Patient will pay") and the PM gets a task to bill the
 * patient instead.
 */
export async function markSelfPay(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string; now?: Date },
): Promise<W13Outcome> {
  const now = ctx.now ?? clockNow();
  const pre = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx
      .select({ claim: claims, patient: patients })
      .from(claims)
      .innerJoin(patients, eq(patients.id, claims.patientId))
      .where(eq(claims.id, ctx.claimId));
    if (!claim) return null;
    return { ...claim, conn: await pmConnection(tx, claim.claim.clientId) };
  });
  if (!pre) return { ok: false, reason: 'not_found' };
  if (!pre.conn) return { ok: false, reason: 'no_connection' };
  const voided = await voidClaim(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    claimId: ctx.claimId,
    reason: 'Patient will pay',
  });
  if (!voided.ok)
    return { ok: false, reason: voided.reason === 'already_sent' ? 'already_sent' : 'not_found' };
  const conn = pre.conn;
  await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    ensurePatientTask(
      tx,
      {
        tenantId: pre.claim.tenantId,
        clientId: pre.claim.clientId,
        patientId: pre.claim.patientId,
        claimId: pre.claim.id,
      },
      conn,
      records.MARK_SELF_PAY,
      () => ({
        title: `Bill the visit as self-pay in ${conn.pmName}`,
        instructions: [
          `In ${conn.pmName}, set this patient's visit to self-pay (no insurance) so the charge goes on the patient's statement.`,
          'The insurance claim was voided in Cleanpost.',
        ],
      }),
      [],
      `user:${ctx.userId}`,
      now,
    ),
  );
  return { ok: true, pmName: conn.pmName };
}
