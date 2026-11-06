/**
 * Writes pulled records into the canonical tables, inside the tenant transaction (CLAUDE.md rule 1).
 * Records are matched through external_refs (connection, entity type, PM ID), so pulling the same
 * page twice changes nothing. Each record created or changed is audit-logged (rule 7); reads made
 * only to compare are logged once per page.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { ExtEncounter, ExtPatient } from '@cleanpost/adapters';
import { records, state } from '@cleanpost/domain';
import {
  chargeLines,
  connections,
  coverages,
  decryptField,
  diagnoses,
  encounters,
  encryptField,
  externalRefs,
  last4,
  manualTasks,
  patients,
  providers,
  recordAudit,
  withAudit,
  workItems,
  type AuditActor,
  type Tx,
} from '@cleanpost/db';
import type { PayerMatcher } from './payers';
import { now as clockNow } from '@cleanpost/clock';

export interface SyncContext {
  tenantId: string;
  clientId: string;
  connectionId: string;
  syncRunId: string;
  actor: AuditActor;
}

export interface Counts {
  new: number;
  changed: number;
  unchanged: number;
  failed: number;
}

export interface Rejected {
  externalId: string | null;
  field: string;
}

export const emptyCounts = (): Counts => ({ new: 0, changed: 0, unchanged: 0, failed: 0 });

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    new: a.new + b.new,
    changed: a.changed + b.changed,
    unchanged: a.unchanged + b.unchanged,
    failed: a.failed + b.failed,
  };
}

/** Key-order-independent equality for JSON-like values. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, x]) => [k, norm(x)]),
          )
        : (v ?? null);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((k) => !same(before[k], after[k]));
}

async function refsFor(tx: Tx, ctx: SyncContext, entityType: string, externalIds: string[]) {
  if (externalIds.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ externalId: externalRefs.externalId, entityId: externalRefs.entityId })
    .from(externalRefs)
    .where(
      and(
        eq(externalRefs.connectionId, ctx.connectionId),
        eq(externalRefs.entityType, entityType),
        inArray(externalRefs.externalId, [...new Set(externalIds)]),
      ),
    );
  return new Map(rows.map((r) => [r.externalId, r.entityId]));
}

async function addRef(tx: Tx, ctx: SyncContext, entityType: string, entityId: string, externalId: string) {
  await tx.insert(externalRefs).values({
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    connectionId: ctx.connectionId,
    entityType,
    entityId,
    externalId,
  });
}

async function auditCompared(tx: Tx, ctx: SyncContext, entityType: string, n: number) {
  if (n === 0) return;
  await recordAudit(tx, {
    actor: ctx.actor,
    action: 'sync.records_compared',
    entityType: 'sync_run',
    entityId: ctx.syncRunId,
    clientId: ctx.clientId,
    metadata: { recordType: entityType, records: n },
  });
}

// ---------- patients and coverage ----------

async function upsertCoverages(
  tx: Tx,
  ctx: SyncContext,
  patientId: string,
  list: ExtPatient['coverages'],
  payers: PayerMatcher,
): Promise<{ added: number; changed: number; pending: number; caughtUp: number }> {
  const refs = await refsFor(
    tx,
    ctx,
    'coverage',
    list.map((c) => c.externalId),
  );
  let added = 0;
  let changed = 0;
  let pending = 0;
  let caughtUp = 0;
  for (const c of list) {
    const fields = {
      payerId: payers.match(c.payerName),
      payerName: c.payerName,
      priority: c.priority,
      groupNumber: c.groupNumber ?? null,
      relationship: c.relationship,
      subscriber: c.subscriber ?? null,
      effectiveDate: c.effectiveDate ?? null,
      terminationDate: c.terminationDate ?? null,
      memberIdLast4: last4(c.memberId),
    };
    const id = refs.get(c.externalId);
    if (!id) {
      const [row] = await tx
        .insert(coverages)
        .values({
          tenantId: ctx.tenantId,
          clientId: ctx.clientId,
          patientId,
          memberIdEncrypted: encryptField(c.memberId),
          source: 'pm',
          ...fields,
        })
        .returning({ id: coverages.id });
      await addRef(tx, ctx, 'coverage', row!.id, c.externalId);
      added++;
      continue;
    }
    const [existing] = await tx.select().from(coverages).where(eq(coverages.id, id));
    if (!existing) continue;
    const diff = changedFields(existing as unknown as Record<string, unknown>, fields).filter(
      // The payer as matched decides; the PM may spell its name differently from Cleanpost's list.
      (f) => !(f === 'payerName' && existing.payerId && existing.payerId === fields.payerId),
    );
    const memberChanged = decryptField(existing.memberIdEncrypted) !== c.memberId;
    if (existing.source !== 'pm') {
      // Corrected in Cleanpost (P-02, P-05): left alone until the PM shows the same (DEC-30).
      if (!diff.length && !memberChanged && existing.patientId === patientId) {
        await tx.update(coverages).set({ source: 'pm', updatedAt: clockNow() }).where(eq(coverages.id, id));
        caughtUp++;
      } else pending++;
      continue;
    }
    if (diff.length || memberChanged || existing.patientId !== patientId) {
      await tx
        .update(coverages)
        .set({
          ...fields,
          patientId,
          ...(memberChanged ? { memberIdEncrypted: encryptField(c.memberId) } : {}),
          updatedAt: clockNow(),
        })
        .where(eq(coverages.id, id));
      changed++;
    }
  }
  return { added, changed, pending, caughtUp };
}

/**
 * DEC-30: once the PM shows a correction made in Cleanpost, the task to make it there closes itself.
 * If the PM still differs and nobody has that task open (a person closed it), a new task says so:
 * the sync conflict note, never a silent overwrite (P-06).
 */
async function settleCorrection(
  tx: Tx,
  ctx: SyncContext,
  patient: { id: string },
  what: 'coverage' | 'details',
  caughtUp: boolean,
) {
  const operation = what === 'coverage' ? records.UPDATE_COVERAGE : records.UPDATE_PATIENT;
  const open = await tx
    .select({ id: workItems.id, status: workItems.status })
    .from(workItems)
    .where(
      and(
        eq(workItems.patientId, patient.id),
        eq(workItems.type, 'manual_task'),
        eq(workItems.reasonCode, operation),
        ne(workItems.status, 'resolved'),
      ),
    );
  const now = clockNow();
  if (caughtUp) {
    for (const item of open) {
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
      if (!next.ok) continue;
      await tx
        .update(workItems)
        .set({
          status: next.value,
          resolvedBy: ctx.actor,
          resolution: 'PM updated',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(workItems.id, item.id));
      await tx
        .update(manualTasks)
        .set({ status: 'done', updatedAt: now })
        .where(and(eq(manualTasks.workItemId, item.id), eq(manualTasks.status, 'open')));
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'work_item.auto_resolved',
        entityType: 'work_item',
        entityId: item.id,
        clientId: ctx.clientId,
        metadata: { operation, syncRunId: ctx.syncRunId },
      });
    }
    return;
  }
  if (open.length) return;
  const [conn] = await tx.select().from(connections).where(eq(connections.id, ctx.connectionId));
  const pmName = ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM';
  const text = records.conflictTask({ what, pmName });
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      type: 'manual_task',
      priority: 2,
      dueAt: new Date(now.getTime() + 24 * 3_600_000),
      patientId: patient.id,
      connectionId: ctx.connectionId,
      reasonCode: operation,
      summary: text.title,
    })
    .returning({ id: workItems.id });
  await tx.insert(manualTasks).values({
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    connectionId: ctx.connectionId,
    operation,
    workItemId: item!.id,
    title: text.title,
    instructions: text.instructions,
  });
  await recordAudit(tx, {
    actor: ctx.actor,
    action: 'manual_task.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: ctx.clientId,
    metadata: { operation, patientId: patient.id, conflict: true },
  });
}

export async function upsertPatients(
  tx: Tx,
  ctx: SyncContext,
  items: ExtPatient[],
  payers: PayerMatcher,
): Promise<Counts> {
  const counts = emptyCounts();
  const refs = await refsFor(
    tx,
    ctx,
    'patient',
    items.map((p) => p.externalId),
  );
  await auditCompared(tx, ctx, 'patient', refs.size);
  for (const p of items) {
    const fields = {
      firstName: p.firstName,
      lastName: p.lastName,
      dob: p.dob,
      sex: p.sex,
      address: p.address ?? null,
      phone: p.phone ?? null,
    };
    const id = refs.get(p.externalId);
    if (!id) {
      await withAudit(
        tx,
        (patientId: string) => ({
          actor: ctx.actor,
          action: 'patient.created',
          entityType: 'patient',
          entityId: patientId,
          clientId: ctx.clientId,
          metadata: {
            connectionId: ctx.connectionId,
            syncRunId: ctx.syncRunId,
            coverages: p.coverages.length,
          },
        }),
        async () => {
          const [row] = await tx
            .insert(patients)
            .values({
              tenantId: ctx.tenantId,
              clientId: ctx.clientId,
              externalIds: { [ctx.connectionId]: p.externalId },
              ...fields,
            })
            .returning({ id: patients.id });
          await addRef(tx, ctx, 'patient', row!.id, p.externalId);
          await upsertCoverages(tx, ctx, row!.id, p.coverages, payers);
          return row!.id;
        },
      );
      counts.new++;
      continue;
    }
    const [existing] = await tx.select().from(patients).where(eq(patients.id, id));
    if (!existing) {
      counts.failed++;
      continue;
    }
    let diff = changedFields(existing as unknown as Record<string, unknown>, fields);
    if (existing.source !== 'pm') {
      // Corrected in Cleanpost (P-06): left alone until the PM shows the same (DEC-30).
      const caughtUp = diff.length === 0;
      if (caughtUp)
        await tx.update(patients).set({ source: 'pm', updatedAt: clockNow() }).where(eq(patients.id, id));
      await settleCorrection(tx, ctx, existing, 'details', caughtUp);
      diff = [];
    } else if (diff.length) {
      await tx
        .update(patients)
        .set({ ...fields, updatedAt: clockNow() })
        .where(eq(patients.id, id));
    }
    const cov = await upsertCoverages(tx, ctx, id, p.coverages, payers);
    if (cov.pending || cov.caughtUp) {
      const stillPending = await tx
        .select({ id: coverages.id })
        .from(coverages)
        .where(and(eq(coverages.patientId, id), ne(coverages.source, 'pm')))
        .limit(1);
      await settleCorrection(tx, ctx, existing, 'coverage', stillPending.length === 0);
    }
    if (diff.length || cov.added || cov.changed) {
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'patient.updated',
        entityType: 'patient',
        entityId: id,
        clientId: ctx.clientId,
        metadata: {
          connectionId: ctx.connectionId,
          syncRunId: ctx.syncRunId,
          fields: diff,
          coveragesAdded: cov.added,
          coveragesChanged: cov.changed,
        },
      });
      counts.changed++;
    } else {
      counts.unchanged++;
    }
  }
  return counts;
}

// ---------- encounters, charge lines and diagnoses ----------

/** PM status -> canonical encounter status. Billed in the PM is still a charge Cleanpost reads. */
const STATUS: Record<ExtEncounter['status'], 'open' | 'ready' | 'void'> = {
  open: 'open',
  ready: 'ready',
  billed: 'ready',
  void: 'void',
};

async function syncLines(tx: Tx, ctx: SyncContext, encounterId: string, e: ExtEncounter) {
  const existing = await tx.select().from(chargeLines).where(eq(chargeLines.encounterId, encounterId));
  const byExt = new Map(existing.map((l) => [l.externalId, l]));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [i, l] of e.lines.entries()) {
    const fields = {
      lineNumber: i + 1,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
      chargeCents: l.chargeCents,
      diagnosisPointers: l.diagnosisPointers,
      ndc: l.ndc ?? null,
    };
    const row = byExt.get(l.externalId);
    if (!row) {
      await tx.insert(chargeLines).values({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        encounterId,
        externalId: l.externalId,
        ...fields,
      });
      added++;
    } else if (changedFields(row as unknown as Record<string, unknown>, fields).length) {
      await tx
        .update(chargeLines)
        .set({ ...fields, updatedAt: clockNow() })
        .where(eq(chargeLines.id, row.id));
      changed++;
    }
  }
  const keep = new Set(e.lines.map((l) => l.externalId));
  const gone = existing.filter((l) => !l.externalId || !keep.has(l.externalId)).map((l) => l.id);
  if (gone.length) {
    await tx.delete(chargeLines).where(inArray(chargeLines.id, gone));
    removed = gone.length;
  }

  const dx = await tx.select().from(diagnoses).where(eq(diagnoses.encounterId, encounterId));
  const bySeq = new Map(dx.map((d) => [d.sequence, d]));
  for (const d of e.diagnoses) {
    const row = bySeq.get(d.sequence);
    if (!row) {
      await tx.insert(diagnoses).values({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        encounterId,
        sequence: d.sequence,
        icd10: d.icd10,
      });
      changed++;
    } else if (row.icd10 !== d.icd10) {
      await tx
        .update(diagnoses)
        .set({ icd10: d.icd10, updatedAt: clockNow() })
        .where(eq(diagnoses.id, row.id));
      changed++;
    }
  }
  const seqs = new Set(e.diagnoses.map((d) => d.sequence));
  const dxGone = dx.filter((d) => !seqs.has(d.sequence)).map((d) => d.id);
  if (dxGone.length) {
    await tx.delete(diagnoses).where(inArray(diagnoses.id, dxGone));
    changed += dxGone.length;
  }
  return { added, changed, removed };
}

export async function upsertEncounters(
  tx: Tx,
  ctx: SyncContext,
  items: ExtEncounter[],
): Promise<{ counts: Counts; rejected: Rejected[] }> {
  const counts = emptyCounts();
  const rejected: Rejected[] = [];
  // One query at a time: a transaction is a single connection.
  const patientRefs = await refsFor(
    tx,
    ctx,
    'patient',
    items.map((e) => e.patientExternalId),
  );
  const encounterRefs = await refsFor(
    tx,
    ctx,
    'encounter',
    items.map((e) => e.externalId),
  );
  const locationRefs = await refsFor(
    tx,
    ctx,
    'location',
    items.map((e) => e.locationExternalId),
  );
  const provs = await tx
    .select({ id: providers.id, npi: providers.npi })
    .from(providers)
    .where(eq(providers.clientId, ctx.clientId));
  const providerByNpi = new Map(provs.map((p) => [p.npi, p.id]));
  await auditCompared(tx, ctx, 'encounter', encounterRefs.size);

  for (const e of items) {
    const patientId = patientRefs.get(e.patientExternalId);
    if (!patientId) {
      // The patient arrives in a later pull; this encounter is retried until it does.
      rejected.push({ externalId: e.externalId, field: 'patientExternalId' });
      counts.failed++;
      continue;
    }
    const fields = {
      patientId,
      dateOfService: e.dateOfService,
      renderingProviderId: providerByNpi.get(e.renderingProviderNpi) ?? null,
      referringProviderId: e.referringProviderNpi
        ? (providerByNpi.get(e.referringProviderNpi) ?? null)
        : null,
      locationId: locationRefs.get(e.locationExternalId) ?? null,
      priorAuthNumber: e.priorAuthNumber ?? null,
      pmStatus: e.pmClaimStatus ?? e.status,
    };
    const id = encounterRefs.get(e.externalId);
    if (!id) {
      await withAudit(
        tx,
        (encounterId: string) => ({
          actor: ctx.actor,
          action: 'encounter.created',
          entityType: 'encounter',
          entityId: encounterId,
          clientId: ctx.clientId,
          metadata: { connectionId: ctx.connectionId, syncRunId: ctx.syncRunId, lines: e.lines.length },
        }),
        async () => {
          const [row] = await tx
            .insert(encounters)
            .values({
              tenantId: ctx.tenantId,
              clientId: ctx.clientId,
              externalIds: { [ctx.connectionId]: e.externalId },
              status: STATUS[e.status],
              ...fields,
            })
            .returning({ id: encounters.id });
          await addRef(tx, ctx, 'encounter', row!.id, e.externalId);
          await syncLines(tx, ctx, row!.id, e);
          return row!.id;
        },
      );
      counts.new++;
      continue;
    }
    const [existing] = await tx.select().from(encounters).where(eq(encounters.id, id));
    if (!existing) {
      counts.failed++;
      continue;
    }
    // Once Cleanpost has built a claim, the encounter's own status belongs to Cleanpost.
    const status = existing.status === 'claimed' ? 'claimed' : STATUS[e.status];
    const next = { ...fields, status };
    const diff = changedFields(existing as unknown as Record<string, unknown>, next);
    if (diff.length) {
      await tx
        .update(encounters)
        .set({ ...next, updatedAt: clockNow() })
        .where(eq(encounters.id, id));
    }
    const lines = await syncLines(tx, ctx, id, e);
    if (diff.length || lines.added || lines.changed || lines.removed) {
      await recordAudit(tx, {
        actor: ctx.actor,
        action: 'encounter.updated',
        entityType: 'encounter',
        entityId: id,
        clientId: ctx.clientId,
        metadata: { connectionId: ctx.connectionId, syncRunId: ctx.syncRunId, fields: diff, ...lines },
      });
      counts.changed++;
    } else {
      counts.unchanged++;
    }
  }
  return { counts, rejected };
}
