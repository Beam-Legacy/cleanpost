'use server';
/**
 * C-02 and C-08 actions: preview an edit's findings, save an edit as a new version, and approve and
 * release (with the same 10-second Undo as W-10). Role and client scope are checked on every call.
 */
import { revalidatePath } from 'next/cache';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  addClaimNote,
  approveClaim,
  editClaim,
  holdClaim,
  previewScrub,
  releaseHold,
  scrubVersion,
  voidClaim,
  type PreviewOutcome,
} from '@cleanpost/claims';
import { claims, coverages, decryptField, patients, withAudit, withTenant, workItems } from '@cleanpost/db';
import { claimPayloadSchema, policy, type ClaimPayload } from '@cleanpost/domain';
import { sendClaimCorrect, sendClaimRelease } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';
import type { WorkActionResult } from '../../work/actions';

const log = createLogger({ name: 'web-claims' });
const Id = z.uuid();

async function claimInScope(
  ctx: ActiveContext,
  claimId: string,
  action: Parameters<typeof policy.assertAllowed>[1],
) {
  const [claim] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select().from(claims).where(eq(claims.id, claimId)),
  );
  policy.assertAllowed(ctx.actor, action, { clientId: claim?.clientId ?? null });
  return claim ?? null;
}

const EDIT_REFUSED: Record<string, string> = {
  stale: 'This claim changed since you opened it. Reload to see the latest version.',
  not_editable: 'This claim can no longer be changed here.',
  locked_field_changed: 'Patient, payer, providers, dates and charges come from the PM; change them there.',
  line_added: 'New lines are added in the PM.',
  no_lines: 'A claim needs at least one line.',
  invalid_value:
    'A value is not valid: codes are 5 characters, modifiers 2, units 1 to 999, pointers 1 to 4.',
  no_change: 'Nothing changed.',
  not_found: 'Claim not found.',
};

export async function previewEdit(
  claimId: string,
  versionId: string,
  payload: ClaimPayload,
): Promise<PreviewOutcome> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'claim.edit');
  return previewScrub(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: id, versionId: Id.parse(versionId) },
    claimPayloadSchema.parse(payload),
  );
}

/** Opens the claim's review item, if any, so corrections rows link to it (docs/08). */
async function reviewItemOf(ctx: ActiveContext, claimId: string) {
  const [item] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, claimId),
          inArray(workItems.type, ['claim_review', 'claim_blocked']),
          ne(workItems.status, 'resolved'),
        ),
      )
      .limit(1),
  );
  return item?.id;
}

async function release(ctx: ActiveContext, claimId: string): Promise<WorkActionResult> {
  const claim = await claimInScope(ctx, claimId, 'claim.release');
  if (!claim) return { ok: false, message: 'Claim not found.' };
  if (claim.status === 'needs_review') {
    const approved = await approveClaim(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, claimId });
    if (!approved.ok) return { ok: false, message: 'This claim is no longer in review.' };
  } else if (claim.status !== 'ready') {
    return { ok: false, message: 'This claim cannot be released now.' };
  }
  const jobId = await sendClaimRelease(
    await getBoss(),
    { tenantId: ctx.tenantId, claimId, userId: ctx.user.id },
    { delaySeconds: 10 },
  );
  return jobId
    ? {
        ok: true,
        done: true,
        message: 'Approved. Releasing in 10 seconds.',
        undo: { kind: 'approve', claimId, jobId },
      }
    : { ok: true, done: true, message: 'Approved. A release for this claim is already queued.' };
}

/** C-11 from the claim page: approve (if in review) and release, with Undo. */
export async function approveAndReleaseClaim(claimId: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  const res = await release(ctx, id);
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  return res;
}

/**
 * C-08 Save: a new version with one corrections row per change, written back to the PM by the
 * worker (Mode A), then scrubbed in place. "Save and release" also approves and releases.
 */
export async function saveEdit(
  claimId: string,
  versionId: string,
  payload: ClaimPayload,
  andRelease: boolean,
): Promise<WorkActionResult & { versionId?: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'claim.edit');
  if (andRelease) policy.assertAllowed(ctx.actor, 'claim.release');
  const itemId = await reviewItemOf(ctx, id);
  const res = await editClaim(
    getDb(),
    {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      claimId: id,
      expectedVersionId: Id.parse(versionId),
      ...(itemId ? { workItemId: itemId } : {}),
    },
    { kind: 'payload', payload: claimPayloadSchema.parse(payload) },
  );
  if (res.status === 'refused') return { ok: false, message: EDIT_REFUSED[res.reason] ?? 'Not saved.' };
  if (res.writeBack)
    await sendClaimCorrect(await getBoss(), {
      tenantId: ctx.tenantId,
      claimId: id,
      versionId: res.versionId,
    });
  const scrub = await scrubVersion(
    { db: getDb(), log },
    { tenantId: ctx.tenantId, claimVersionId: res.versionId },
    `user:${ctx.user.id}`,
  );
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  const saved = `Saved as version ${res.version} with ${res.changes.length === 1 ? '1 change' : `${res.changes.length} changes`}.`;
  if (!andRelease) return { ok: true, message: saved, versionId: res.versionId };
  if (scrub.status === 'scrubbed' && scrub.decision === 'blocked')
    return {
      ok: false,
      message: `${saved} A blocking problem remains, so it was not released.`,
      versionId: res.versionId,
    };
  const released = await release(ctx, id);
  return { ...released, message: `${saved} ${released.message}`, versionId: res.versionId };
}

/**
 * G-12: the full DOB or member ID, for one person, recorded each time (reveal or copy). The page
 * masks it again after 30 seconds.
 */
export async function revealField(
  claimId: string,
  field: 'dob' | 'member_id',
  purpose: 'reveal' | 'copy',
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  const kind = z.enum(['dob', 'member_id']).parse(field);
  const why = z.enum(['reveal', 'copy']).parse(purpose);
  await claimInScope(ctx, id, 'claim.view');
  const value = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [row] = await tx
      .select({ claim: claims, dob: patients.dob, memberId: coverages.memberIdEncrypted })
      .from(claims)
      .innerJoin(patients, eq(patients.id, claims.patientId))
      .leftJoin(coverages, eq(coverages.id, claims.coverageId))
      .where(eq(claims.id, id));
    if (!row) return null;
    if (kind === 'member_id' && !row.memberId) return null;
    return withAudit(
      tx,
      {
        actor: `user:${ctx.user.id}`,
        action: why === 'copy' ? 'phi.copied' : 'phi.revealed',
        entityType: 'claim',
        entityId: id,
        clientId: row.claim.clientId,
        metadata: { field: kind },
      },
      async () => (kind === 'dob' ? row.dob : decryptField(row.memberId!)),
    );
  });
  return value === null ? { ok: false, message: 'Nothing to show.' } : { ok: true, value };
}

/** C-13: void a claim that was never sent (DEC-15). */
export async function voidClaimAction(
  claimId: string,
  reason: string,
  note: string | null,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'claim.edit');
  const res = await voidClaim(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    claimId: id,
    reason: z.string().max(100).parse(reason),
    note: note === null ? null : z.string().max(1000).parse(note),
  });
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  if (res.ok) return { ok: true, message: 'Claim voided. Its open items are closed.' };
  return {
    ok: false,
    message:
      res.reason === 'already_sent'
        ? 'The payer already has this claim; voiding it needs a void claim (frequency 8), which comes with corrections.'
        : res.reason === 'note_required'
          ? 'Add a note for "Other".'
          : 'Not voided.',
  };
}

/** C-16: a note on the timeline. */
export async function addNoteAction(claimId: string, text: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'work.resolve');
  const res = await addClaimNote(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    claimId: id,
    text: z.string().max(2000).parse(text),
  });
  revalidatePath(`/claims/${id}`);
  return res.ok ? { ok: true, message: 'Note added.' } : { ok: false, message: 'Write a note first.' };
}

/** C-12 Hold claim. */
export async function holdAction(
  claimId: string,
  reason: string,
  until: string | null,
  note: string | null,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'claim.edit');
  const res = await holdClaim(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    claimId: id,
    reason: z.string().max(100).parse(reason),
    until: until === null ? null : z.iso.date().parse(until),
    note: note === null ? null : z.string().max(1000).parse(note),
  });
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  if (res.ok)
    return { ok: true, message: until ? `On hold until ${until}.` : 'On hold until you release it.' };
  const msg: Record<string, string> = {
    past_deadline: 'Pick a date at least 14 days before the filing deadline.',
    note_required: 'Add a note for "Other".',
    not_holdable: 'This claim cannot be held now.',
  };
  return { ok: false, message: msg[res.reason] ?? 'Not held.' };
}

/** C-12 Release hold: back to built, scrubbed again with what is on file now. */
export async function releaseHoldAction(claimId: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  await claimInScope(ctx, id, 'claim.edit');
  const res = await releaseHold(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: id });
  if (!res.ok) return { ok: false, message: 'This claim is not on hold.' };
  await scrubVersion(
    { db: getDb(), log },
    { tenantId: ctx.tenantId, claimVersionId: res.versionId },
    `user:${ctx.user.id}`,
  );
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  return { ok: true, message: 'Hold released. The claim was checked again.' };
}
