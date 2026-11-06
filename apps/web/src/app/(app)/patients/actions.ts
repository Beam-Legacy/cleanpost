'use server';
/**
 * P-01 / P-03 actions: check a coverage's eligibility again (a 270, billed per check), and reveal
 * the date of birth or member ID (G-12, audited). Claims waiting on the coverage are scrubbed again.
 * P-02 / P-06 corrections and the W-13 actions (DEC-30): saved in Cleanpost with a task for the PM.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  editCoverage,
  editPatient,
  markSelfPay,
  rescrubForCoverage,
  useOtherCoverage,
  type RecordEditOutcome,
} from '@cleanpost/claims';
import { claims, coverages, decryptField, patients, payers, withAudit, withTenant } from '@cleanpost/db';
import { policy, records } from '@cleanpost/domain';
import { getPatientForEdit, type PatientEditView } from '@/lib/queries/patients';
import { checkCoverage, versionsWaitingOnCoverage } from '@cleanpost/eligibility';
import { sendClaimScrub } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { eligibilityClient } from '@/lib/eligibility';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-patients' });
const Id = z.uuid();

export interface PatientActionResult {
  ok: boolean;
  message: string;
  checkId?: string;
}

async function scrubAll(tenantId: string, versionIds: string[]) {
  if (!versionIds.length) return;
  const boss = await getBoss();
  for (const claimVersionId of new Set(versionIds)) await sendClaimScrub(boss, { tenantId, claimVersionId });
}

/** P-01 Check eligibility again / P-03 Check again / W-13 Check again. */
export async function checkEligibilityAction(coverageId: string): Promise<PatientActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(coverageId);
  const [cov] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ clientId: coverages.clientId, patientId: coverages.patientId, payerName: payers.name })
      .from(coverages)
      .leftJoin(payers, eq(payers.id, coverages.payerId))
      .where(eq(coverages.id, id)),
  );
  policy.assertAllowed(ctx.actor, 'work.resolve', { clientId: cov?.clientId ?? null });
  if (!cov) return { ok: false, message: 'Coverage not found.' };
  const client = eligibilityClient();
  if (!client) return { ok: false, message: 'Eligibility checks are not set up here yet.' };
  const res = await checkCoverage({ db: getDb(), client, log }, { tenantId: ctx.tenantId, coverageId: id });
  revalidatePath(`/patients/${cov.patientId}`);
  const payer = cov.payerName ?? 'The payer';
  if (res.status === 'checked') {
    // Claims built and waiting for this check, and claims it held (W-13), are scrubbed with it.
    const waiting = await versionsWaitingOnCoverage(getDb(), ctx.tenantId, id);
    const held = await rescrubForCoverage(getDb(), {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      coverageId: id,
    });
    await scrubAll(ctx.tenantId, [...waiting, ...held]);
    return {
      ok: true,
      checkId: res.checkId,
      message:
        res.result === 'active'
          ? `${payer}: coverage active.`
          : res.result === 'inactive'
            ? `${payer}: coverage not active on the date of service.`
            : `${payer} answered without a clear status.`,
    };
  }
  if (res.status === 'failed')
    return { ok: false, message: `${payer} did not respond (${res.code}). Try again in a few minutes.` };
  return {
    ok: false,
    message:
      res.reason === 'no_payer_id'
        ? `${payer} has no electronic payer ID in Cleanpost yet.`
        : res.reason === 'no_billing_npi'
          ? 'The client has no billing NPI on file.'
          : 'Coverage not found.',
  };
}

/** G-12 on P-01: the date of birth, or a coverage's member ID. Each reveal and copy is audited. */
export async function revealPatientField(
  target: { patientId: string } | { coverageId: string },
  purpose: 'reveal' | 'copy',
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const ctx = await requireActiveContext();
  const why = z.enum(['reveal', 'copy']).parse(purpose);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    if ('patientId' in target) {
      const [p] = await tx
        .select()
        .from(patients)
        .where(eq(patients.id, Id.parse(target.patientId)));
      if (!p) return { ok: false, message: 'Not found.' };
      policy.assertAllowed(ctx.actor, 'claim.view', { clientId: p.clientId });
      const value = await withAudit(
        tx,
        {
          actor: `user:${ctx.user.id}`,
          action: why === 'copy' ? 'phi.copied' : 'phi.revealed',
          entityType: 'patient',
          entityId: p.id,
          clientId: p.clientId,
          metadata: { field: 'dob' },
        },
        async () => p.dob,
      );
      return { ok: true, value };
    }
    const [c] = await tx
      .select()
      .from(coverages)
      .where(eq(coverages.id, Id.parse(target.coverageId)));
    if (!c) return { ok: false, message: 'Not found.' };
    policy.assertAllowed(ctx.actor, 'claim.view', { clientId: c.clientId });
    const value = await withAudit(
      tx,
      {
        actor: `user:${ctx.user.id}`,
        action: why === 'copy' ? 'phi.copied' : 'phi.revealed',
        entityType: 'coverage',
        entityId: c.id,
        clientId: c.clientId,
        metadata: { field: 'member_id' },
      },
      async () => decryptField(c.memberIdEncrypted),
    );
    return { ok: true, value };
  });
}

export interface EditResult {
  ok: boolean;
  message: string;
  field?: string;
}

function refused(res: Extract<RecordEditOutcome, { ok: false }>): EditResult {
  if (res.reason === 'invalid')
    return { ok: false, message: res.message ?? 'Check the highlighted field.', field: res.field };
  if (res.reason === 'no_change') return { ok: false, message: 'Nothing changed.' };
  if (res.reason === 'no_connection')
    return { ok: false, message: 'This client has no PM connection to update.' };
  return { ok: false, message: 'Not found.' };
}

async function clientOfCoverage(tenantId: string, userId: string, coverageId: string) {
  const [c] = await withTenant(getDb(), { tenantId, userId }, (tx) =>
    tx
      .select({ clientId: coverages.clientId, patientId: coverages.patientId })
      .from(coverages)
      .where(eq(coverages.id, coverageId)),
  );
  return c ?? null;
}

/** P-02 Save coverage (W-13 Update coverage). */
export async function editCoverageAction(coverageId: string, input: unknown): Promise<EditResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(coverageId);
  const parsed = records.coverageEditSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue?.message ?? 'Check the form.', field: String(issue?.path[0] ?? '') };
  }
  const cov = await clientOfCoverage(ctx.tenantId, ctx.user.id, id);
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: cov?.clientId ?? null });
  if (!cov) return { ok: false, message: 'Coverage not found.' };
  const res = await editCoverage(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    coverageId: id,
    edit: parsed.data,
  });
  if (!res.ok) return refused(res);
  let checked = '';
  if (parsed.data.checkEligibility) {
    const check = await checkEligibilityAction(id);
    checked = ` ${check.message}`;
  } else {
    await scrubAll(ctx.tenantId, res.versionIds);
  }
  revalidatePath(`/patients/${cov.patientId}`);
  revalidatePath('/work');
  return {
    ok: true,
    message: `Coverage saved. A task to update ${res.pmName} is in the queue.${checked}`,
  };
}

/** P-06: the patient's current details, revealed to edit them (audited). */
export async function patientForEditAction(patientId: string): Promise<PatientEditView | null> {
  const ctx = await requireActiveContext();
  return getPatientForEdit(ctx, Id.parse(patientId));
}

/** P-06 Save details. */
export async function editPatientAction(patientId: string, input: unknown): Promise<EditResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(patientId);
  const parsed = records.patientEditSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: issue?.message ?? 'Check the form.',
      field: String(issue?.path.at(-1) ?? ''),
    };
  }
  const [p] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select({ clientId: patients.clientId }).from(patients).where(eq(patients.id, id)),
  );
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: p?.clientId ?? null });
  if (!p) return { ok: false, message: 'Patient not found.' };
  const res = await editPatient(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    patientId: id,
    edit: parsed.data,
  });
  if (!res.ok) return refused(res);
  await scrubAll(ctx.tenantId, res.versionIds);
  revalidatePath(`/patients/${id}`);
  revalidatePath('/work');
  return { ok: true, message: `Details saved. A task to update ${res.pmName} is in the queue.` };
}

const W13_REFUSED: Record<string, string> = {
  not_found: 'Not found.',
  not_active: 'That coverage is not confirmed active. Check it again first.',
  already_sent: 'The claim has already gone out.',
  no_connection: 'This client has no PM connection.',
};

/** W-13 Use other coverage: a task to bill the other insurance in the PM. */
export async function useOtherCoverageAction(claimId: string, coverageId: string): Promise<EditResult> {
  const ctx = await requireActiveContext();
  const [c] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ clientId: claims.clientId })
      .from(claims)
      .where(eq(claims.id, Id.parse(claimId))),
  );
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: c?.clientId ?? null });
  const res = await useOtherCoverage(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    claimId: Id.parse(claimId),
    coverageId: Id.parse(coverageId),
  });
  revalidatePath('/work');
  return res.ok
    ? { ok: true, message: `A task to bill the other coverage in ${res.pmName} is in the queue.` }
    : { ok: false, message: W13_REFUSED[res.reason] ?? 'Could not do that.' };
}

/** W-13 Mark self-pay: void the claim and ask the PM to bill the patient. */
export async function markSelfPayAction(claimId: string): Promise<EditResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  const [c] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select({ clientId: claims.clientId }).from(claims).where(eq(claims.id, id)),
  );
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: c?.clientId ?? null });
  const res = await markSelfPay(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: id });
  revalidatePath('/work');
  return res.ok
    ? {
        ok: true,
        message: `Claim voided as self-pay. A task to bill the patient in ${res.pmName} is in the queue.`,
      }
    : { ok: false, message: W13_REFUSED[res.reason] ?? 'Could not do that.' };
}
