'use server';
/**
 * W-01 actions. Each checks the role and the client scope, goes through the state machines in
 * `packages/claims` and `@cleanpost/work`, and is recorded with the user as actor. PM writes happen
 * in the worker (claim.correct, claim.release); the web app only queues them.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { approveClaim, editClaim, scrubVersion, unapproveClaim } from '@cleanpost/claims';
import { claims, claimVersions, scrubResults, withTenant, workItems } from '@cleanpost/db';
import { policy, type policy as P } from '@cleanpost/domain';
import { cancelClaimRelease, sendClaimCorrect, sendClaimRelease } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { assignItem, reopenItem, resolveItem, snoozeItem, wakeItem } from '@cleanpost/work';
import { listAssignees, type Assignee } from '@/lib/queries/work';
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
