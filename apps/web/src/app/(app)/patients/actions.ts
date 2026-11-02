'use server';
/**
 * P-01 / P-03 actions: check a coverage's eligibility again (a 270, billed per check), and reveal
 * the date of birth or member ID (G-12, audited). Claims waiting on the coverage are scrubbed again.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { coverages, decryptField, patients, payers, withAudit, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
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

/** P-01 Check eligibility again / P-03 Check again. */
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
    const boss = await getBoss();
    for (const claimVersionId of await versionsWaitingOnCoverage(getDb(), ctx.tenantId, id))
      await sendClaimScrub(boss, { tenantId: ctx.tenantId, claimVersionId });
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
