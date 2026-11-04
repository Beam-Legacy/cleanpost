'use server';
/**
 * W-01 actions. Each checks the role and the client scope, goes through the state machines in
 * `packages/claims` and `@cleanpost/work`, and is recorded with the user as actor. PM writes happen
 * in the worker (claim.correct, claim.release); the web app only queues them.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  approveClaim,
  buildCorrection,
  decideWriteOff,
  editClaim,
  requestWriteOff,
  scrubVersion,
  unapproveClaim,
  WRITE_OFF_REASONS,
  writeOffClaim,
  writeOffDenials,
} from '@cleanpost/claims';
import {
  claims,
  claimVersions,
  savedViews,
  scrubResults,
  withTenant,
  workItems,
  writeOffRequests,
} from '@cleanpost/db';
import { formatCents, policy, type policy as P } from '@cleanpost/domain';
import { cancelClaimRelease, sendClaimCorrect, sendClaimRelease, sendClaimScrub } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import {
  confirmPosting,
  ESCALATION_REASONS,
  escalatePosting,
  linkPayment,
  mappingInputSchema,
  saveMapping,
  SET_ASIDE_REASONS,
  setAsidePayment,
} from '@cleanpost/remit';
import { assignItem, reopenItem, resolveItem, snoozeItem, wakeItem } from '@cleanpost/work';
import { getWorkDetail, listAssignees, viewQuery, type Assignee } from '@/lib/queries/work';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-work' });
const Id = z.uuid();
/** Undo window for an approval (docs/09 "Undo for 10 seconds"). */
const RELEASE_DELAY_SECONDS = 10;

export type Undo =
  | { kind: 'approve'; claimId: string; jobId: string }
  | { kind: 'snooze'; itemId: string }
  | { kind: 'resolve'; itemId: string };

export interface WorkActionResult {
  ok: boolean;
  message: string;
  undo?: Undo;
  /** The item is done: the queue moves to the next one. */
  done?: boolean;
}

async function scoped(ctx: ActiveContext, action: P.Action, ids: { itemId?: string; claimId?: string }) {
  const { item, claim } = await withTenant(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      const [item] = ids.itemId ? await tx.select().from(workItems).where(eq(workItems.id, ids.itemId)) : [];
      const [claim] = ids.claimId ? await tx.select().from(claims).where(eq(claims.id, ids.claimId)) : [];
      return { item: item ?? null, claim: claim ?? null };
    },
  );
  const clientId = claim?.clientId ?? item?.clientId ?? null;
  policy.assertAllowed(ctx.actor, action, { clientId });
  if (ids.claimId && item?.claimId && item.claimId !== ids.claimId) throw new Error('item and claim differ');
  return { item, claim };
}

const FIX_REFUSED: Record<string, string> = {
  stale: 'This claim changed since you opened it. The panel now shows the latest version.',
  not_editable: 'This claim can no longer be changed here.',
  no_fix: 'That suggested fix is no longer on the claim.',
  needs_editor: 'This fix needs a choice; open the claim to make it.',
  no_matching_line: 'No line matches that fix any more.',
  no_change: 'Nothing to change: the claim already has that fix.',
  would_empty_claim: 'That fix would remove every line. Open the claim to fix it by hand.',
};

/** Applies findings' suggested fixes as one new version, writes it back (Mode A) and re-scrubs. */
async function fix(
  ctx: ActiveContext,
  input: { itemId: string; claimId: string; versionId: string; ruleIds: string[] },
) {
  const res = await editClaim(
    getDb(),
    {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      claimId: input.claimId,
      workItemId: input.itemId,
      expectedVersionId: input.versionId,
    },
    { kind: 'fix', ruleIds: input.ruleIds },
  );
  if (res.status === 'refused')
    return { ok: false as const, message: FIX_REFUSED[res.reason] ?? 'The fix was not applied.' };
  if (res.writeBack)
    await sendClaimCorrect(await getBoss(), {
      tenantId: ctx.tenantId,
      claimId: input.claimId,
      versionId: res.versionId,
    });
  // Re-scrub in place so the panel shows the new score now (W-10). The AI step runs in the worker
  // only; a person is looking at this claim.
  const scrub = await scrubVersion(
    { db: getDb(), log },
    { tenantId: ctx.tenantId, claimVersionId: res.versionId },
    `user:${ctx.user.id}`,
  );
  return { ok: true as const, res, scrub };
}

export async function applyFixes(input: {
  itemId: string;
  claimId: string;
  versionId: string;
  ruleIds: string[];
}): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const data = z
    .object({
      itemId: Id,
      claimId: Id,
      versionId: Id,
      ruleIds: z.array(z.string().min(1).max(200)).min(1).max(20),
    })
    .parse(input);
  await scoped(ctx, 'claim.edit', data);
  const out = await fix(ctx, data);
  revalidatePath('/work');
  if (!out.ok) return out;
  const n = out.res.changes.length;
  const score = out.scrub.status === 'scrubbed' ? ` Confidence now ${out.scrub.confidence}.` : '';
  return { ok: true, message: `${n === 1 ? '1 change' : `${n} changes`} saved as a new version.${score}` };
}

/**
 * W-10 primary: (apply the fixes,) approve and release. The release waits 10 seconds so Undo can
 * stop it before anything reaches the PM.
 */
export async function approveAndRelease(input: {
  itemId: string;
  claimId: string;
  versionId: string;
  ruleIds?: string[];
}): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const data = z
    .object({
      itemId: Id,
      claimId: Id,
      versionId: Id,
      ruleIds: z.array(z.string().min(1).max(200)).max(20).optional(),
    })
    .parse(input);
  await scoped(ctx, 'claim.release', data);
  if (data.ruleIds?.length) {
    policy.assertAllowed(ctx.actor, 'claim.edit');
    const out = await fix(ctx, { ...data, ruleIds: data.ruleIds });
    if (!out.ok) {
      revalidatePath('/work');
      return out;
    }
    if (out.scrub.status === 'scrubbed' && out.scrub.decision === 'blocked') {
      revalidatePath('/work');
      return { ok: false, message: 'Fixed, but a blocking problem remains. Review the findings.' };
    }
  }
  const { claim } = await scoped(ctx, 'claim.release', { claimId: data.claimId });
  if (!claim) return { ok: false, message: 'Claim not found.' };
  if (claim.status === 'needs_review') {
    const approved = await approveClaim(getDb(), {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      claimId: claim.id,
    });
    if (!approved.ok) return { ok: false, message: 'This claim is no longer in review.' };
  } else if (claim.status !== 'ready') {
    revalidatePath('/work');
    return { ok: false, message: 'This claim cannot be released now. The panel shows why.' };
  }
  const jobId = await sendClaimRelease(
    await getBoss(),
    { tenantId: ctx.tenantId, claimId: claim.id, userId: ctx.user.id },
    { delaySeconds: RELEASE_DELAY_SECONDS },
  );
  revalidatePath('/work');
  return jobId
    ? {
        ok: true,
        done: true,
        message: 'Approved. Releasing in 10 seconds.',
        undo: { kind: 'approve', claimId: claim.id, jobId },
      }
    : { ok: true, done: true, message: 'Approved. A release for this claim is already queued.' };
}

export async function undo(input: Undo): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const tenant = { tenantId: ctx.tenantId, userId: ctx.user.id };
  let result: WorkActionResult;
  if (input.kind === 'approve') {
    const data = z.object({ claimId: Id, jobId: z.uuid() }).parse(input);
    await scoped(ctx, 'claim.release', { claimId: data.claimId });
    const cancelled = await cancelClaimRelease(await getBoss(), data.jobId);
    if (!cancelled) {
      result = { ok: false, message: 'Too late to undo: the release has started.' };
    } else {
      const res = await unapproveClaim(getDb(), { ...tenant, claimId: data.claimId });
      result = res.ok
        ? { ok: true, message: 'Approval undone. The claim is back in review.' }
        : { ok: false, message: 'Too late to undo: the claim has been released.' };
    }
  } else {
    const itemId = Id.parse(input.itemId);
    await scoped(ctx, 'work.resolve', { itemId });
    const res =
      input.kind === 'snooze'
        ? await wakeItem(getDb(), tenant, itemId)
        : await reopenItem(getDb(), tenant, itemId);
    result = res.ok
      ? { ok: true, message: input.kind === 'snooze' ? 'Snooze undone.' : 'Item reopened.' }
      : { ok: false, message: 'This item has changed since; nothing was undone.' };
  }
  revalidatePath('/work');
  return result;
}

const SNOOZE_REFUSED: Record<string, string> = {
  past: 'Pick a time in the future.',
  too_far: 'Snooze for at most 30 days.',
  invalid_transition: 'This item cannot be snoozed now.',
  not_found: 'Item not found.',
};

export async function snooze(itemId: string, untilIso: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const until = new Date(z.iso.datetime({ offset: true }).parse(untilIso));
  await scoped(ctx, 'work.resolve', { itemId: id });
  const res = await snoozeItem(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, until);
  revalidatePath('/work');
  if (!res.ok) return { ok: false, message: SNOOZE_REFUSED[res.reason] ?? 'Not snoozed.' };
  const when = until
    .toLocaleString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    })
    .replace(' AM', ' am')
    .replace(' PM', ' pm');
  return { ok: true, done: true, message: `Snoozed until ${when}.`, undo: { kind: 'snooze', itemId: id } };
}

export async function resolve(
  itemId: string,
  reason: string,
  note: string | null,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const data = z
    .object({ reason: z.string().min(1).max(100), note: z.string().max(1000).nullable() })
    .parse({ reason, note });
  await scoped(ctx, 'work.resolve', { itemId: id });
  const res = await resolveItem(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, data);
  revalidatePath('/work');
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'note_required'
          ? 'Add a note for "Other".'
          : res.reason === 'unknown_reason'
            ? 'Pick a reason from the list.'
            : res.reason === 'decided_elsewhere'
              ? 'Approve or decline the write-off instead.'
              : 'This item cannot be resolved now.',
    };
  return { ok: true, done: true, message: 'Resolved.', undo: { kind: 'resolve', itemId: id } };
}

const Ids = z.array(Id).min(1).max(200);

/** W-05: who may take these items (access to every item's client), with their workload. */
export async function assigneesFor(itemIds: string[]): Promise<Assignee[]> {
  const ctx = await requireActiveContext();
  const ids = Ids.parse(itemIds);
  const clientIds = new Set<string>();
  for (const itemId of ids) {
    const { item } = await scoped(ctx, 'work.resolve', { itemId });
    if (item?.clientId) clientIds.add(item.clientId);
  }
  return listAssignees(ctx, [...clientIds]);
}

/** W-05 Assign (one item or the W-04 selection); null unassigns. */
export async function assign(itemIds: string[], assigneeId: string | null): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const ids = Ids.parse(itemIds);
  const to = assigneeId === null ? null : Id.parse(assigneeId);
  if (to) {
    const allowed = await assigneesFor(ids);
    if (!allowed.some((a) => a.id === to))
      return { ok: false, message: 'That person cannot see every selected client.' };
  }
  let done = 0;
  for (const itemId of ids) {
    await scoped(ctx, 'work.resolve', { itemId });
    const res = await assignItem(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, itemId, to);
    if (res.ok) done++;
  }
  revalidatePath('/work');
  const what = ids.length === 1 ? 'Item' : `${done} of ${ids.length} items`;
  return { ok: done > 0, message: to ? `${what} assigned.` : `${what} unassigned.` };
}

/** W-04 Snooze for the selection. */
export async function snoozeMany(itemIds: string[], untilIso: string): Promise<WorkActionResult> {
  const ids = Ids.parse(itemIds);
  let done = 0;
  for (const id of ids) if ((await snooze(id, untilIso)).ok) done++;
  return { ok: done > 0, message: `${done} of ${ids.length} items snoozed.` };
}

/**
 * C-17 Bulk release: claim reviews whose findings are all info level, approved and released at
 * once by this user. Checked again here; anything else is skipped and counted, never dropped silently.
 */
export async function bulkRelease(
  itemIds: string[],
): Promise<WorkActionResult & { released: number; skipped: number }> {
  const ctx = await requireActiveContext();
  const ids = Ids.parse(itemIds);
  policy.assertAllowed(ctx.actor, 'claim.release');
  const boss = await getBoss();
  let released = 0;
  let skipped = 0;
  for (const itemId of ids) {
    const { item } = await scoped(ctx, 'claim.release', { itemId });
    if (!item?.claimId || item.type !== 'claim_review') {
      skipped++;
      continue;
    }
    const eligible = await withTenant(
      getDb(),
      { tenantId: ctx.tenantId, userId: ctx.user.id },
      async (tx) => {
        const [row] = await tx
          .select({ status: claims.status, findings: scrubResults.findings })
          .from(claims)
          .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
          .innerJoin(scrubResults, eq(scrubResults.id, claimVersions.scrubResultId))
          .where(eq(claims.id, item.claimId!));
        return (
          row &&
          (row.status === 'needs_review' || row.status === 'ready') &&
          ((row.findings as { items?: { severity: string }[] }).items ?? []).every(
            (f) => f.severity === 'info',
          )
        );
      },
    );
    if (!eligible) {
      skipped++;
      continue;
    }
    const approved = await approveClaim(getDb(), {
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      claimId: item.claimId,
    });
    if (!approved.ok && approved.reason !== 'not_in_review') {
      skipped++;
      continue;
    }
    await sendClaimRelease(boss, { tenantId: ctx.tenantId, claimId: item.claimId, userId: ctx.user.id });
    released++;
  }
  revalidatePath('/work');
  return {
    ok: released > 0,
    released,
    skipped,
    message: `Releasing ${released} ${released === 1 ? 'claim' : 'claims'}.${skipped ? ` ${skipped} skipped: not eligible any more.` : ''}`,
  };
}

/** W-08 Save view: a name per person; sharing with the team is for admins. */
export async function saveView(
  name: string,
  filters: Record<string, string>,
  shared: boolean,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'work.view');
  const clean = z.string().trim().min(1).max(60).parse(name);
  if (shared && ctx.actor.role !== 'admin')
    return { ok: false, message: 'Only admins can share views with the team.' };
  const query = viewQuery(filters);
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [dup] = await tx
      .select({ id: savedViews.id })
      .from(savedViews)
      .where(
        and(eq(savedViews.userId, ctx.user.id), eq(savedViews.surface, 'work'), eq(savedViews.name, clean)),
      );
    if (dup) return false;
    await tx.insert(savedViews).values({
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      surface: 'work',
      name: clean,
      filters: Object.fromEntries(new URLSearchParams(query)),
      shared,
    });
    return true;
  });
  revalidatePath('/work');
  return res
    ? { ok: true, message: `View "${clean}" saved.` }
    : { ok: false, message: 'You already have a view with that name.' };
}

export async function deleteView(viewId: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(viewId);
  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.delete(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.userId, ctx.user.id))),
  );
  revalidatePath('/work');
  return { ok: true, message: 'View removed.' };
}

/** W-19: map an 835 adjustment code to the PM's code (admins); closes the item and checks again. */
export async function mapAdjustmentCode(
  itemId: string,
  input: { pmAdjustmentCode: string; action: string; scope: string },
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const { item } = await scoped(ctx, 'mappings.manage', { itemId: id });
  if (!item || item.type !== 'mapping_needed' || !item.clientId)
    return { ok: false, message: 'This item is not a mapping request.' };
  const [groupCode, carc] = item.reasonCode.split('-');
  const parsed = mappingInputSchema.safeParse({ ...input, clientId: item.clientId, groupCode, carc });
  if (!parsed.success)
    return { ok: false, message: 'Enter the PM code (letters and numbers) and choose what it does.' };
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    saveMapping(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, parsed.data),
  );
  revalidatePath('/work');
  revalidatePath('/remittances');
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'denial_code'
          ? `${item.reasonCode} is a denial: it stays open for the denial queue and is never mapped.`
          : 'This client has no PM connection to map codes for.',
    };
  log.info({ itemId: id, itemsClosed: res.itemsClosed }, 'adjustment code mapped');
  return {
    ok: true,
    done: true,
    message: `Mapped ${item.reasonCode} to ${parsed.data.pmAdjustmentCode.toUpperCase()}; postings checked again.`,
  };
}

const LINK_REFUSED: Record<string, string> = {
  not_found: 'This payment is no longer waiting to be linked.',
  not_unmatched: 'This payment was already linked or set aside.',
  claim_not_found: 'That claim is not one of this client’s.',
};

/** W-17: link an unmatched payment to the claim it pays; the posting match runs once all are linked. */
export async function linkUnmatchedPayment(itemId: string, claimId: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const claim = Id.parse(claimId);
  await scoped(ctx, 'payment.post', { itemId: id });
  await scoped(ctx, 'payment.post', { claimId: claim });
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    linkPayment(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, { itemId: id, claimId: claim }),
  );
  revalidatePath('/work');
  revalidatePath('/remittances');
  if (!res.ok) return { ok: false, message: LINK_REFUSED[res.reason] ?? 'The payment could not be linked.' };
  return { ok: true, done: true, message: 'Payment linked to the claim.' };
}

/** W-17: set an unmatched payment aside (billed before go-live, or not this client's). */
export async function setAsideUnmatchedPayment(itemId: string, reason: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const why = z.enum(SET_ASIDE_REASONS).parse(reason);
  await scoped(ctx, 'payment.post', { itemId: id });
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    setAsidePayment(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, { itemId: id, reason: why }),
  );
  revalidatePath('/work');
  revalidatePath('/remittances');
  if (!res.ok)
    return { ok: false, message: LINK_REFUSED[res.reason] ?? 'The payment could not be set aside.' };
  return { ok: true, done: true, message: `Set aside: ${why.toLowerCase()}.` };
}

const POSTING_REFUSED: Record<string, string> = {
  not_found: 'This is not a posting task.',
  not_open: 'This task is already done.',
  reference_required: 'Enter the payment ID the PM gave this payment.',
};

/** M-01 Mark as posted, with the PM's payment ID (required). */
export async function markPosted(itemId: string, pmReference: string): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const ref = z.string().max(100).parse(pmReference);
  await scoped(ctx, 'payment.post', { itemId: id });
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    confirmPosting(tx, { tenantId: ctx.tenantId, userId: ctx.user.id }, { itemId: id, pmReference: ref }),
  );
  revalidatePath('/work');
  revalidatePath('/remittances');
  revalidatePath('/tasks');
  if (!res.ok)
    return { ok: false, message: POSTING_REFUSED[res.reason] ?? 'The task could not be completed.' };
  return { ok: true, done: true, message: 'Marked as posted.' };
}

/** M-02 Couldn't complete: the reason and a note; the task goes to the owner. */
export async function couldNotComplete(
  itemId: string,
  reason: string,
  note: string,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const why = z.enum(ESCALATION_REASONS).parse(reason);
  const text = z.string().max(500).parse(note).trim();
  if (why === 'Other' && !text) return { ok: false, message: 'Add a note for "Other".' };
  await scoped(ctx, 'payment.post', { itemId: id });
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    escalatePosting(
      tx,
      { tenantId: ctx.tenantId, userId: ctx.user.id },
      { itemId: id, reason: why, note: text || null },
    ),
  );
  revalidatePath('/work');
  revalidatePath('/tasks');
  if (!res.ok)
    return { ok: false, message: POSTING_REFUSED[res.reason] ?? 'The task could not be escalated.' };
  return { ok: true, done: true, message: 'Sent to the owner with your reason.' };
}

const CORRECTION_REFUSED: Record<string, string> = {
  not_found: 'Claim not found.',
  not_denied: 'Only a denied or partly paid claim can be corrected this way.',
  no_payer_claim_number:
    'The payer’s claim number is missing from the payment, so a corrected claim cannot reference it.',
  in_flight: 'A corrected claim is already on its way.',
  needs_editor: 'This fix needs a value: open the claim to correct it.',
  no_matching_line: 'The line the fix is for is no longer on the claim.',
  no_change: 'Nothing to change.',
};

/**
 * W-16 / D-02 Build correction: a new version with frequency 7 and the payer's claim number, with
 * the suggested fix for the denied line applied (worked out again here, never taken from the
 * browser). The scrub runs next; the editor (C-09) opens on it.
 */
export async function buildCorrectionFromItem(
  itemId: string,
  lineNumber: number | null,
): Promise<WorkActionResult & { claimId?: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const { item } = await scoped(ctx, 'claim.edit', { itemId: id });
  if (!item?.claimId || item.type !== 'denial') return { ok: false, message: 'This is not a denial.' };
  const detail = await getWorkDetail(ctx, id);
  const advice = detail?.denial?.advice.find((a) => lineNumber !== null && a.lineNumber === lineNumber);
  const suggestion =
    advice?.advice.suggestion && !advice.advice.suggestion.needsInput ? advice.advice.suggestion : null;
  const res = await buildCorrection(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: item.claimId, workItemId: id },
    suggestion ? { fix: { fix: suggestion.fix, lineNumbers: suggestion.lineNumbers } } : {},
  );
  if (res.status !== 'built')
    return { ok: false, message: CORRECTION_REFUSED[res.reason] ?? 'The correction could not be built.' };
  await sendClaimScrub(await getBoss(), { tenantId: ctx.tenantId, claimVersionId: res.versionId });
  log.info({ claimId: item.claimId, version: res.version, fixed: res.fixed }, 'correction built');
  revalidatePath('/work');
  revalidatePath(`/claims/${item.claimId}`);
  return {
    ok: true,
    message: res.fixed
      ? 'Corrected claim built with the fix; it is being checked.'
      : 'Corrected claim built; make the change in the editor.',
    claimId: item.claimId,
  };
}

const WRITE_OFF_REFUSED: Record<string, string> = {
  not_found: 'Claim not found.',
  not_open: 'This claim has no open balance to write off.',
  amount: 'The amount cannot be more than the open balance.',
  note_required: 'Add a note (needed for "Other" and for amounts over $100).',
  over_limit: 'This is over your approval limit: request approval instead.',
  already_requested: 'A write-off for this claim is already waiting for an admin.',
  not_pending: 'This request has already been decided.',
};

const writeOffSchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.enum(WRITE_OFF_REASONS),
  note: z.string().max(500),
  pmCode: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_.-]+$/),
  itemId: Id.nullable().optional(),
  /** The denial had a suggested correction the person chose not to take (recorded, D-02). */
  suggestionNotTaken: z.boolean().optional(),
});

type WriteOffForm = z.input<typeof writeOffSchema>;

/** Validates the D-03 form against the claim and the denial item it came from. */
async function writeOffInput(ctx: ActiveContext, claimId: string, input: WriteOffForm) {
  const id = Id.parse(claimId);
  const data = writeOffSchema.safeParse(input);
  if (!data.success) return { error: 'Choose a reason and the PM write-off code.' } as const;
  const { claim } = await scoped(ctx, 'work.resolve', {
    claimId: id,
    ...(data.data.itemId ? { itemId: data.data.itemId } : {}),
  });
  return {
    id,
    claim,
    input: {
      amountCents: data.data.amountCents,
      reason: data.data.reason,
      note: data.data.note.trim() || null,
      pmCode: data.data.pmCode,
      denialItemId: data.data.itemId ?? null,
      suggestionNotTaken: Boolean(data.data.suggestionNotTaken),
    },
  } as const;
}

function revalidateWriteOff(claimId: string) {
  revalidatePath('/work');
  revalidatePath('/denials');
  revalidatePath(`/claims/${claimId}`);
}

/**
 * C-14 / D-03 Write off a claim's open balance (by default the denied amount) with a reason; Mode A
 * leaves a task to post it in the PM. Over the tenant's approval limit only an admin may.
 */
export async function writeOffAction(claimId: string, form: WriteOffForm): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const v = await writeOffInput(ctx, claimId, form);
  if (v.error) return { ok: false, message: v.error };
  const overLimit = policy.authorize(ctx.actor, 'denial.write_off', { clientId: v.claim?.clientId ?? null })
    .allowed
    ? 'allowed'
    : 'refused';
  const res = await writeOffClaim(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: v.id, overLimit },
    v.input,
  );
  revalidateWriteOff(v.id);
  if (res.status !== 'written_off')
    return { ok: false, message: WRITE_OFF_REFUSED[res.reason] ?? 'Not written off.' };
  return {
    ok: true,
    done: true,
    message: res.workItemId ? 'Written off. A task posts the adjustment in the PM.' : 'Written off.',
  };
}

/** D-03 Request approval: a biller's write-off over the limit goes to the admins' queue. */
export async function requestWriteOffAction(claimId: string, form: WriteOffForm): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const v = await writeOffInput(ctx, claimId, form);
  if (v.error) return { ok: false, message: v.error };
  const res = await requestWriteOff(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: v.id },
    v.input,
  );
  revalidateWriteOff(v.id);
  if (res.status !== 'requested')
    return { ok: false, message: WRITE_OFF_REFUSED[res.reason] ?? 'The request was not sent.' };
  return { ok: true, message: 'Sent to an admin for approval. You will be notified of the decision.' };
}

/** W-01 approval panel: an admin approves (the write-off is done now) or declines with a note. */
export async function decideWriteOffAction(
  itemId: string,
  decision: 'approve' | 'decline',
  note: string,
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const data = z
    .object({ decision: z.enum(['approve', 'decline']), note: z.string().max(500) })
    .parse({ decision, note });
  const { item } = await scoped(ctx, 'denial.write_off', { itemId: id });
  if (item?.type !== 'write_off_approval') return { ok: false, message: 'This is not a write-off request.' };
  const [req] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ id: writeOffRequests.id })
      .from(writeOffRequests)
      .where(eq(writeOffRequests.approvalItemId, id)),
  );
  if (!req) return { ok: false, message: 'The request was not found.' };
  const res = await decideWriteOff(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, requestId: req.id },
    data.decision,
    data.note.trim() || null,
  );
  if (item.claimId) revalidateWriteOff(item.claimId);
  if (res.status === 'refused')
    return { ok: false, message: WRITE_OFF_REFUSED[res.reason] ?? 'Nothing was decided.' };
  return {
    ok: true,
    done: true,
    message:
      res.status === 'approved'
        ? res.workItemId
          ? 'Approved and written off. A task posts the adjustment in the PM.'
          : 'Approved and written off.'
        : 'Declined. The biller has been told.',
  };
}

/** D-03 bulk (admin): the denied amount of each selected denial, one reason and PM code for all. */
export async function bulkWriteOffAction(
  itemIds: string[],
  form: { reason: string; note: string; pmCode: string },
): Promise<WorkActionResult> {
  const ctx = await requireActiveContext();
  const ids = Ids.parse(itemIds);
  const data = writeOffSchema.pick({ reason: true, note: true, pmCode: true }).safeParse(form);
  if (!data.success) return { ok: false, message: 'Choose a reason and the PM write-off code.' };
  for (const itemId of ids) await scoped(ctx, 'denial.write_off', { itemId });
  const res = await writeOffDenials(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, ids, {
    ...data.data,
    note: data.data.note.trim() || null,
  });
  revalidatePath('/work');
  revalidatePath('/denials');
  const done = `${res.writtenOff} of ${ids.length} written off (${formatCents(res.cents)}).`;
  if (!res.refused.length) return { ok: true, done: true, message: done };
  const why = [...new Set(res.refused.map((r) => WRITE_OFF_REFUSED[r.reason] ?? r.reason))].join(' ');
  return { ok: res.writtenOff > 0, message: `${done} Not written off: ${why}` };
}
