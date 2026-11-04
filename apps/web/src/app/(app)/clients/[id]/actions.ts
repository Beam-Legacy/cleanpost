'use server';
/**
 * CL-02 / CL-08: pause and resume a client, and record its onboarding baseline. Admins only;
 * audited. Resume queues what waited: releases of ready claims and PM corrections.
 */
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { pauseClient, resumeClient } from '@cleanpost/claims';
import { now as clockNow } from '@cleanpost/clock';
import { clients, recordAudit, withTenant } from '@cleanpost/db';
import { baselineInputSchema, policy, state } from '@cleanpost/domain';
import { sendClaimCorrect, sendClaimRelease } from '@cleanpost/jobs';
import { createLogger } from '@cleanpost/log';
import { getBoss } from '@/lib/jobs';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const log = createLogger({ name: 'web-clients' });

export interface ClientActionResult {
  ok: boolean;
  message: string;
}

async function admin(clientId: string) {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'client.manage', { clientId });
  return ctx;
}

const PauseInput = z.object({
  reason: z.enum(state.PAUSE_REASONS),
  note: z.string().trim().max(500).nullable(),
  resumeOn: z.iso.date().nullable(),
});

export async function pauseClientAction(
  clientId: string,
  input: z.infer<typeof PauseInput>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const res = await pauseClient(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    id,
    PauseInput.parse(input),
    clockNow(),
  );
  revalidatePath(`/clients/${id}`);
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'note_required'
          ? 'Add a note to say why.'
          : res.reason === 'invalid_state'
            ? 'Only a live client can be paused.'
            : 'That client is not in this company.',
    };
  return { ok: true, message: 'Paused. Syncing continues; nothing is sent to payers or written to the PM.' };
}

export async function resumeClientAction(clientId: string): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const res = await resumeClient(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, id, clockNow());
  revalidatePath(`/clients/${id}`);
  if (!res.ok) return { ok: false, message: 'Only a paused client can be resumed.' };
  const boss = await getBoss();
  for (const claimId of res.toRelease) await sendClaimRelease(boss, { tenantId: ctx.tenantId, claimId });
  for (const c of res.toCorrect) await sendClaimCorrect(boss, { tenantId: ctx.tenantId, ...c });
  log.info({ released: res.toRelease.length, corrections: res.toCorrect.length }, 'client resumed');
  const waited = res.toRelease.length + res.toCorrect.length;
  return {
    ok: true,
    message: waited
      ? `Resumed. ${waited === 1 ? 'One claim that waited is' : `${waited} claims that waited are`} going out now.`
      : 'Resumed.',
  };
}

/** The practice's figures before Cleanpost, from its own reports (totals only). */
export async function saveBaselineAction(
  clientId: string,
  input: z.input<typeof baselineInputSchema>,
): Promise<ClientActionResult> {
  const id = z.uuid().parse(clientId);
  const ctx = await admin(id);
  const parsed = baselineInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Check the figures: rates are percents from 0 to 100.' };
  const b = parsed.data;
  if (b.collectionsCents === null && b.firstPass === null && b.denialRate === null && b.daysInAr === null)
    return { ok: false, message: 'Enter at least one figure.' };
  const ok = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, id));
    if (!c) return false;
    await tx
      .update(clients)
      .set({ baseline: { ...b, recordedAt: clockNow().toISOString(), recordedBy: `user:${ctx.user.id}` } })
      .where(eq(clients.id, id));
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'client.baseline_recorded',
      entityType: 'client',
      entityId: id,
      clientId: id,
      metadata: {
        figures: ['collectionsCents', 'firstPass', 'denialRate', 'daysInAr'].filter(
          (k) => b[k as keyof typeof b] !== null,
        ),
      },
    });
    return true;
  });
  revalidatePath(`/clients/${id}`);
  revalidatePath(`/reports/clients/${id}`);
  return ok
    ? { ok: true, message: 'Baseline saved. Reports compare against it from now on.' }
    : { ok: false, message: 'That client is not in this company.' };
}
