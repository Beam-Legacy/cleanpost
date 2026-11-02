'use server';
/**
 * C-15 / W-15: a person's claim status check (276/277) and the task its answer implies. A check
 * waits up to 15 seconds for the payer; when it gets no answer it is queued again for an hour later.
 * Once a day per claim (the sweep checks open follow-ups weekly).
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { checkClaimStatus, createStatusTask } from '@cleanpost/claims';
import { claims, payers, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { sendClaimStatusCheck } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { claimStatusClient } from '@/lib/claim-status';
import { getBoss } from '@/lib/jobs';
import { statusViewInTx } from '@/lib/queries/claim-status';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-claim-status' });
const Id = z.uuid();
const TIMEOUT_MS = 15_000;

export interface StatusActionResult {
  ok: boolean;
  message: string;
  /** A new answer is stored: show it (C-15). */
  checked?: boolean;
}

async function scopedClaim(ctx: ActiveContext, claimId: string) {
  const [row] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ clientId: claims.clientId, payerName: payers.name })
      .from(claims)
      .leftJoin(payers, eq(payers.id, claims.payerId))
      .where(eq(claims.id, claimId)),
  );
  policy.assertAllowed(ctx.actor, 'work.resolve', { clientId: row?.clientId ?? null });
  return row ?? null;
}

const when = (d: Date) =>
  d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm');

export async function checkStatusAction(claimId: string): Promise<StatusActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  const row = await scopedClaim(ctx, id);
  if (!row) return { ok: false, message: 'Claim not found.' };
  const payer = row.payerName ?? 'The payer';
  const client = claimStatusClient();
  if (!client) return { ok: false, message: 'Status checks are not set up here yet.' };
  const res = await checkClaimStatus(
    { db: getDb(), client, log },
    { tenantId: ctx.tenantId, claimId: id, trigger: 'manual', userId: ctx.user.id },
    { timeoutMs: TIMEOUT_MS },
  );
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  if (res.status === 'checked')
    return {
      ok: true,
      checked: true,
      message: res.accepted ? `${payer} has the claim: it is now marked accepted.` : 'Status checked.',
    };
  if (res.status === 'failed') {
    if (!res.retryable) return { ok: false, message: `${payer} could not take the request (${res.code}).` };
    await sendClaimStatusCheck(
      await getBoss(),
      { tenantId: ctx.tenantId, claimId: id, trigger: 'retry' },
      { delaySeconds: 3600 },
    );
    return { ok: false, message: `${payer} did not respond. We will try again in an hour.` };
  }
  const refused: Record<typeof res.reason, string> = {
    not_found: 'Claim not found.',
    not_out: 'Only a claim that has been sent can be checked.',
    rate_limited: `Checked at ${res.lastAt ? when(res.lastAt) : 'an earlier time'}; a claim can be checked once a day.`,
    no_payer_id: `${payer} has no electronic payer ID in Cleanpost yet.`,
    no_billing_npi: 'The client has no billing NPI on file.',
    no_coverage: 'The claim has no coverage to look it up by.',
  };
  return { ok: false, message: refused[res.reason] };
}

/** C-15 Create task: worked out again from the stored answer, never taken from the browser. */
export async function createStatusTaskAction(claimId: string): Promise<StatusActionResult> {
  const ctx = await requireActiveContext();
  const id = Id.parse(claimId);
  if (!(await scopedClaim(ctx, id))) return { ok: false, message: 'Claim not found.' };
  const view = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    statusViewInTx(tx, id),
  );
  const advice = view?.last?.advice;
  if (!advice?.task) return { ok: false, message: 'The latest status needs no task.' };
  const res = await createStatusTask(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, claimId: id },
    { advice },
  );
  revalidatePath(`/claims/${id}`);
  revalidatePath('/work');
  revalidatePath('/tasks');
  if (res.status === 'created') return { ok: true, message: `Task created: ${advice.task.title}.` };
  return {
    ok: false,
    message:
      res.reason === 'exists'
        ? 'That task is already open.'
        : res.reason === 'no_connection'
          ? 'This client has no PM connection to attach the task to.'
          : 'No task was created.',
  };
}
