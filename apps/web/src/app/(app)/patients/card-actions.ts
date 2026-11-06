'use server';
/**
 * P-04 card upload, P-05 / W-14 review and confirm (DEC-31). Photos go to encrypted storage; the
 * reading runs in the worker (document ID only in the job). Confirming changes the coverage through
 * P-02's path, with the same task for the PM.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { connections, documents, externalRefs, patients, recordAudit, withTenant } from '@cleanpost/db';
import { policy } from '@cleanpost/domain';
import {
  cardForReview,
  cardState,
  confirmCard,
  discardCard,
  uploadCard,
  type CardReview,
} from '@cleanpost/documents';
import { sendClaimScrub, sendDocumentExtract } from '@cleanpost/jobs';
import { documentUrl } from '@/lib/document-urls';
import { getBoss } from '@/lib/jobs';
import { coverageViews, payerOptions, type CoverageView } from '@/lib/queries/patients';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { sampleCard, simConfig, type SampleCard } from '@/lib/sim';
import { checkEligibilityAction } from './actions';

const Id = z.uuid();

async function patientClient(tenantId: string, userId: string, patientId: string) {
  const [p] = await withTenant(getDb(), { tenantId, userId }, (tx) =>
    tx.select({ clientId: patients.clientId }).from(patients).where(eq(patients.id, patientId)),
  );
  return p?.clientId ?? null;
}

async function documentClient(tenantId: string, userId: string, documentId: string) {
  const [d] = await withTenant(getDb(), { tenantId, userId }, (tx) =>
    tx
      .select({ clientId: documents.clientId, patientId: documents.patientId })
      .from(documents)
      .where(eq(documents.id, documentId)),
  );
  return d ?? null;
}

export interface UploadResult {
  ok: boolean;
  message: string;
  frontId?: string;
}

const UPLOAD_REFUSED: Record<string, string> = {
  too_large: 'is over 15 MB. Use a smaller photo.',
  not_an_image: 'is not a photo. Use a JPEG, PNG or WebP image.',
  empty: 'is empty.',
};

/** P-04: the photos of one card (front required, back optional). */
export async function uploadCardAction(form: FormData): Promise<UploadResult> {
  const ctx = await requireActiveContext();
  const patientId = Id.parse(form.get('patientId'));
  const clientId = await patientClient(ctx.tenantId, ctx.user.id, patientId);
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId });
  const front = form.get('front');
  const back = form.get('back');
  if (!(front instanceof File) || front.size === 0)
    return { ok: false, message: 'Choose a photo of the front.' };
  const res = await uploadCard(
    getDb(),
    { tenantId: ctx.tenantId, userId: ctx.user.id, patientId },
    {
      front: new Uint8Array(await front.arrayBuffer()),
      back: back instanceof File && back.size > 0 ? new Uint8Array(await back.arrayBuffer()) : null,
    },
  );
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'not_found'
          ? 'Patient not found.'
          : `The ${res.side === 'back' ? 'back' : 'front'} photo ${UPLOAD_REFUSED[res.reason]}`,
    };
  const boss = await getBoss();
  for (const documentId of [res.front, res.back].filter((x): x is string => Boolean(x)))
    await sendDocumentExtract(boss, { tenantId: ctx.tenantId, documentId });
  return { ok: true, message: 'Reading the card…', frontId: res.front };
}

/** P-04 progress (no PHI). */
export async function cardStateAction(documentId: string) {
  const ctx = await requireActiveContext();
  return cardState(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    documentId: Id.parse(documentId),
  });
}

export interface CardReviewData {
  card: CardReview;
  frontUrl: string;
  backUrl: string | null;
  coverages: CoverageView[];
  payers: { id: string; name: string }[];
  pmName: string;
}

/** P-05 / W-14: what was read, the images (short-lived links) and the coverages it could update. */
export async function cardReviewAction(documentId: string): Promise<CardReviewData | null> {
  const ctx = await requireActiveContext();
  const id = Id.parse(documentId);
  const d = await documentClient(ctx.tenantId, ctx.user.id, id);
  if (!d || !policy.authorize(ctx.actor, 'claim.edit', { clientId: d.clientId }).allowed) return null;
  const card = await cardForReview(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, documentId: id });
  if (!card) return null;
  const extra = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [conn] = await tx
      .select({ settings: connections.settings })
      .from(connections)
      .where(eq(connections.clientId, card.clientId))
      .limit(1);
    return {
      coverages: await coverageViews(tx, card.patientId),
      payers: await payerOptions(tx),
      pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM',
    };
  });
  return {
    card,
    frontUrl: documentUrl(card.documentId, ctx.user.id),
    backUrl: card.backDocumentId ? documentUrl(card.backDocumentId, ctx.user.id) : null,
    ...extra,
  };
}

const confirmInput = z.object({
  coverageId: z.uuid(),
  payerId: z.uuid(),
  memberId: z.string().trim().min(2, 'Enter the member ID.').max(30),
  groupNumber: z.string().trim().max(30),
  checkEligibility: z.boolean(),
});

/** P-05 Confirm card / W-14 Confirm. */
export async function confirmCardAction(
  documentId: string,
  input: unknown,
): Promise<{ ok: boolean; message: string }> {
  const ctx = await requireActiveContext();
  const id = Id.parse(documentId);
  const parsed = confirmInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the fields.' };
  const d = await documentClient(ctx.tenantId, ctx.user.id, id);
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: d?.clientId ?? null });
  const res = await confirmCard(getDb(), {
    tenantId: ctx.tenantId,
    userId: ctx.user.id,
    documentId: id,
    coverageId: parsed.data.coverageId,
    fields: {
      payerId: parsed.data.payerId,
      memberId: parsed.data.memberId,
      groupNumber: parsed.data.groupNumber,
    },
    checkEligibility: parsed.data.checkEligibility,
  });
  if (!res.ok)
    return {
      ok: false,
      message:
        res.reason === 'already_confirmed'
          ? 'This card was already confirmed.'
          : res.reason === 'not_read'
            ? 'The card has not been read yet.'
            : (res.message ?? 'Could not confirm the card.'),
    };
  let checked = '';
  if (res.coverageChanged && parsed.data.checkEligibility) {
    checked = ` ${(await checkEligibilityAction(parsed.data.coverageId)).message}`;
  } else if (res.versionIds.length) {
    const boss = await getBoss();
    for (const claimVersionId of res.versionIds)
      await sendClaimScrub(boss, { tenantId: ctx.tenantId, claimVersionId });
  }
  if (d?.patientId) revalidatePath(`/patients/${d.patientId}`);
  revalidatePath('/work');
  return {
    ok: true,
    message: res.coverageChanged
      ? `Card confirmed and coverage updated. A task to update ${res.pmName} is in the queue.${checked}`
      : 'Card confirmed; it matches the coverage on file.',
  };
}

/** P-04 Cancel: delete a card nobody confirmed. */
export async function discardCardAction(documentId: string): Promise<boolean> {
  const ctx = await requireActiveContext();
  const id = Id.parse(documentId);
  const d = await documentClient(ctx.tenantId, ctx.user.id, id);
  policy.assertAllowed(ctx.actor, 'claim.edit', { clientId: d?.clientId ?? null });
  const ok = await discardCard(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, documentId: id });
  if (d?.patientId) revalidatePath(`/patients/${d.patientId}`);
  return ok;
}

/**
 * Local and preview only (DEC-31): the patient's card as the mock PM has it, to draw a synthetic
 * photo in the browser for the demo. Audited without the values.
 */
export async function sampleCardAction(patientId: string): Promise<SampleCard | null> {
  const config = simConfig();
  if (!config) return null;
  const ctx = await requireActiveContext();
  const id = Id.parse(patientId);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [p] = await tx.select({ clientId: patients.clientId }).from(patients).where(eq(patients.id, id));
    if (!p || !policy.authorize(ctx.actor, 'claim.edit', { clientId: p.clientId }).allowed) return null;
    const [conn] = await tx
      .select({ id: connections.id, adapterKey: connections.adapterKey, settings: connections.settings })
      .from(connections)
      .where(eq(connections.clientId, p.clientId))
      .limit(1);
    const practiceId = ((conn?.settings ?? {}) as { practiceId?: string }).practiceId;
    if (!conn || conn.adapterKey !== 'mock' || !practiceId) return null;
    const [ref] = await tx
      .select({ externalId: externalRefs.externalId })
      .from(externalRefs)
      .where(
        and(
          eq(externalRefs.connectionId, conn.id),
          eq(externalRefs.entityType, 'patient'),
          eq(externalRefs.entityId, id),
        ),
      );
    if (!ref) return null;
    const card = await sampleCard(config, practiceId, ref.externalId);
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'sim.sample_card',
      entityType: 'patient',
      entityId: id,
      clientId: p.clientId,
      metadata: { found: Boolean(card) },
    });
    return card;
  });
}
