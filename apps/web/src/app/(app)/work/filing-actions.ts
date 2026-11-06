'use server';
/**
 * W-22 timely-filing actions: escalate to an admin (assigned, told at once), and document proof of
 * timely filing (stored encrypted, the item resolved "Documented with payer"). Release now and Fix
 * blocker reuse the queue's own actions.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { memberships, withTenant, workItems } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import { uploadFilingProof } from '@cleanpost/documents';
import { assignItem, resolveItem } from '@cleanpost/work';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const Id = z.uuid();

async function itemClient(tenantId: string, userId: string, itemId: string) {
  const [i] = await withTenant(getDb(), { tenantId, userId }, (tx) =>
    tx
      .select({ clientId: workItems.clientId, type: workItems.type })
      .from(workItems)
      .where(eq(workItems.id, itemId)),
  );
  return i ?? null;
}

export async function escalateAction(
  itemId: string,
  adminId: string,
): Promise<{ ok: boolean; message: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(itemId);
  const to = Id.parse(adminId);
  const item = await itemClient(ctx.tenantId, ctx.user.id, id);
  policy.assertAllowed(ctx.actor, 'work.resolve', { clientId: item?.clientId ?? null });
  if (item?.type !== 'timely_filing_risk')
    return { ok: false, message: 'Only timely-filing items escalate.' };
  const [admin] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ id: memberships.userId })
      .from(memberships)
      .where(
        and(eq(memberships.userId, to), eq(memberships.role, 'admin'), eq(memberships.status, 'active')),
      ),
  );
  if (!admin) return { ok: false, message: 'Choose an admin.' };
  const res = await assignItem(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, to, {
    escalated: true,
  });
  revalidatePath('/work');
  return res.ok
    ? { ok: true, message: 'Escalated. The admin was told right away.' }
    : { ok: false, message: 'Not escalated.' };
}

const PROOF_REFUSED: Record<string, string> = {
  too_large: 'The file is over 15 MB.',
  not_a_document: 'Use a PDF or a photo (JPEG, PNG or WebP).',
  empty: 'The file is empty.',
  not_found: 'Item not found.',
};

export async function filingProofAction(form: FormData): Promise<{ ok: boolean; message: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(form.get('itemId'));
  const file = form.get('file');
  const item = await itemClient(ctx.tenantId, ctx.user.id, id);
  policy.assertAllowed(ctx.actor, 'work.resolve', { clientId: item?.clientId ?? null });
  if (!(file instanceof File)) return { ok: false, message: 'Choose a file.' };
  const up = await uploadFilingProof(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, itemId: id },
    new Uint8Array(await file.arrayBuffer()),
  );
  if (!up.ok) return { ok: false, message: PROOF_REFUSED[up.reason] ?? 'Not uploaded.' };
  const res = await resolveItem(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, {
    reason: 'Documented with payer',
    note: 'Proof of timely filing uploaded.',
  });
  revalidatePath('/work');
  return res.ok
    ? { ok: true, message: 'Proof saved and the item resolved.' }
    : { ok: true, message: 'Proof saved. Resolve the item when you are done.' };
}
