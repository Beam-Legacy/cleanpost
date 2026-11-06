/**
 * Insurance cards (P-04, P-05, W-14; DEC-31). A photo of each side is stored encrypted, read by the
 * card reader in a job (IDs only in the payload), and confirmed by a person before it changes the
 * coverage: the model reads, deterministic code saves (CLAUDE.md rule 9). Fields the reader was not
 * sure about (under 0.9) are marked, and an unconfirmed card with such fields is a W-14 item.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CardReader, CardReading } from '@cleanpost/ai';
import { editCoverage } from '@cleanpost/claims';
import { now as clockNow } from '@cleanpost/clock';
import {
  corrections,
  coverages,
  decryptField,
  documents,
  encryptField,
  patients,
  payers,
  recordAudit,
  withAudit,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
} from '@cleanpost/db';
import { state } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { loadPayerMatcher } from '@cleanpost/sync';
import { deleteBlob, MAX_DOCUMENT_BYTES, putBlob, readBlob, sniffImage, type ImageType } from './store';

export const LOW_CONFIDENCE = 0.9;
export const CARD_TYPES = { front: 'insurance_card_front', back: 'insurance_card_back' } as const;
/** The fields that decide the coverage; one read under 0.9 makes the card a W-14 item. */
export const DECIDING_FIELDS = ['payerName', 'memberId', 'groupNumber', 'subscriberName'] as const;

export interface CardFields {
  payerName: string | null;
  memberId: string | null;
  groupNumber: string | null;
  subscriberName: string | null;
  planType: string | null;
  rxBin: string | null;
  payerPhone: string | null;
}
export type CardFieldName = keyof CardFields;
export type Confidence = Partial<Record<CardFieldName, number | null>>;

/** What `documents.extracted` holds: the member ID encrypted like a coverage's. */
interface Extracted {
  status: 'read' | 'unreadable';
  reader: string;
  fields?: Omit<CardFields, 'memberId'>;
  memberIdEncrypted?: string | null;
  confidence?: Confidence;
  payerId?: string | null;
}

const EMPTY: CardFields = {
  payerName: null,
  memberId: null,
  groupNumber: null,
  subscriberName: null,
  planType: null,
  rxBin: null,
  payerPhone: null,
};

/** Front and back of one upload share a key prefix: cards/<upload>/front, cards/<upload>/back. */
const keyOf = (upload: string, side: 'front' | 'back') => `cards/${upload}/${side}`;
const otherSide = (key: string) =>
  key.endsWith('/front') ? key.replace(/\/front$/, '/back') : key.replace(/\/back$/, '/front');

export type UploadOutcome =
  | { ok: true; front: string; back: string | null }
  | {
      ok: false;
      reason: 'too_large' | 'not_an_image' | 'empty' | 'not_found';
      side: 'front' | 'back' | null;
    };

/** P-04: store the photos (encrypted) and their documents. The caller queues the reading. */
export async function uploadCard(
  db: Database,
  ctx: { tenantId: string; userId: string; patientId: string },
  files: { front: Uint8Array; back?: Uint8Array | null },
): Promise<UploadOutcome> {
  const sides: ['front' | 'back', Uint8Array][] = [['front', files.front]];
  if (files.back?.length) sides.push(['back', files.back]);
  const types = new Map<'front' | 'back', ImageType>();
  for (const [side, bytes] of sides) {
    if (!bytes.length) return { ok: false, reason: 'empty', side };
    if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large', side };
    const t = sniffImage(bytes);
    if (!t) return { ok: false, reason: 'not_an_image', side };
    types.set(side, t);
  }
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [p] = await tx
      .select({ clientId: patients.clientId })
      .from(patients)
      .where(eq(patients.id, ctx.patientId));
    if (!p) return { ok: false, reason: 'not_found', side: null };
    const upload = uuidv7();
    const ids: Record<string, string> = {};
    for (const [side, bytes] of sides) {
      const key = keyOf(upload, side);
      await putBlob(tx, {
        tenantId: ctx.tenantId,
        clientId: p.clientId,
        key,
        contentType: types.get(side)!,
        bytes,
      });
      const [doc] = await tx
        .insert(documents)
        .values({
          tenantId: ctx.tenantId,
          clientId: p.clientId,
          patientId: ctx.patientId,
          type: CARD_TYPES[side],
          storageKey: key,
          reviewStatus: 'pending',
        })
        .returning({ id: documents.id });
      ids[side] = doc!.id;
      await recordAudit(tx, {
        actor,
        action: 'document.uploaded',
        entityType: 'document',
        entityId: doc!.id,
        clientId: p.clientId,
        metadata: { type: CARD_TYPES[side], sizeBytes: bytes.length, contentType: types.get(side)! },
      });
    }
    return { ok: true, front: ids.front!, back: ids.back ?? null };
  });
}

const minConfidence = (c: Confidence, fields: readonly CardFieldName[]) => {
  const vals = fields.map((f) => c[f]).filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.min(...vals) : 0;
};

export interface ExtractDeps {
  db: Database;
  reader: CardReader;
  log: Logger;
  now?: () => Date;
}

/** document.extract: read one side of a card and keep what was read (job; IDs only). */
export async function extractCard(
  deps: ExtractDeps,
  ctx: { tenantId: string; documentId: string },
): Promise<{ status: 'read' | 'unreadable' | 'skipped'; review?: boolean }> {
  const actor: AuditActor = 'automation:document.extract';
  const loaded = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [doc] = await tx.select().from(documents).where(eq(documents.id, ctx.documentId));
    if (!doc || doc.extracted || !Object.values(CARD_TYPES).includes(doc.type as never)) return null;
    const blob = await withAudit(
      tx,
      {
        actor,
        action: 'document.read',
        entityType: 'document',
        entityId: doc.id,
        clientId: doc.clientId,
        metadata: { purpose: 'card_reading' },
      },
      () => readBlob(tx, doc.storageKey),
    );
    return blob ? { doc, blob } : null;
  });
  if (!loaded) return { status: 'skipped' };
  const { doc, blob } = loaded;
  let reading: CardReading;
  try {
    reading = await deps.reader.readCard({ bytes: blob.bytes, contentType: blob.contentType as ImageType });
  } catch (err) {
    // The job retries; the error says what failed, never what the card says.
    deps.log.warn({ documentId: doc.id, err: (err as Error).name }, 'card reading failed');
    throw err;
  }
  const now = deps.now?.() ?? clockNow();
  return withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    if (reading.unreadable) {
      const extracted: Extracted = { status: 'unreadable', reader: deps.reader.name };
      await tx.update(documents).set({ extracted, updatedAt: now }).where(eq(documents.id, doc.id));
      await recordAudit(tx, {
        actor,
        action: 'document.extracted',
        entityType: 'document',
        entityId: doc.id,
        clientId: doc.clientId,
        metadata: { status: 'unreadable', reader: deps.reader.name },
      });
      return { status: 'unreadable' };
    }
    const { memberId, ...rest } = reading.fields;
    const matcher = await loadPayerMatcher(tx, doc.clientId);
    const payerId = rest.payerName ? matcher.match(rest.payerName) : null;
    const extracted: Extracted = {
      status: 'read',
      reader: deps.reader.name,
      fields: rest,
      memberIdEncrypted: memberId ? encryptField(memberId) : null,
      confidence: reading.confidence,
      payerId,
    };
    const front = doc.type === CARD_TYPES.front;
    const sure = minConfidence(reading.confidence, front ? DECIDING_FIELDS : ['rxBin', 'payerPhone']);
    await tx
      .update(documents)
      .set({ extracted, extractionConfidence: sure.toFixed(3), updatedAt: now })
      .where(eq(documents.id, doc.id));
    // W-14: the front of a card the reader was not sure about waits for a person.
    const review =
      front &&
      (sure < LOW_CONFIDENCE || !rest.payerName || !memberId || (rest.payerName != null && !payerId));
    if (review) {
      const [item] = await tx
        .insert(workItems)
        .values({
          tenantId: doc.tenantId,
          clientId: doc.clientId,
          type: 'card_review',
          priority: 3,
          dueAt: new Date(now.getTime() + 48 * 3_600_000),
          documentId: doc.id,
          patientId: doc.patientId,
          reasonCode: 'low_confidence',
          summary: 'Check the card fields the reader was not sure about',
        })
        .returning({ id: workItems.id });
      await recordAudit(tx, {
        actor,
        action: 'work_item.created',
        entityType: 'work_item',
        entityId: item!.id,
        clientId: doc.clientId,
        metadata: { type: 'card_review', documentId: doc.id },
      });
    }
    await recordAudit(tx, {
      actor,
      action: 'document.extracted',
      entityType: 'document',
      entityId: doc.id,
      clientId: doc.clientId,
      metadata: { status: 'read', reader: deps.reader.name, review, payerMatched: Boolean(payerId) },
    });
    return { status: 'read', review };
  });
}

/** P-04 progress: where the reading of a card stands. Carries no PHI. */
export async function cardState(
  db: Database,
  ctx: { tenantId: string; userId: string; documentId: string },
): Promise<{ state: 'reading' | 'unreadable' | 'read'; reviewStatus: string } | null> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [doc] = await tx
      .select({ extracted: documents.extracted, reviewStatus: documents.reviewStatus })
      .from(documents)
      .where(eq(documents.id, ctx.documentId));
    if (!doc) return null;
    const e = doc.extracted as Extracted | null;
    return { state: e ? e.status : 'reading', reviewStatus: doc.reviewStatus };
  });
}

export interface CardReview {
  documentId: string;
  backDocumentId: string | null;
  patientId: string;
  clientId: string;
  state: 'reading' | 'unreadable' | 'read';
  reviewStatus: string;
  fields: CardFields;
  confidence: Confidence;
  /** Fields under 0.9 (or missing), in reading order: marked and focused first (P-05). */
  unsure: CardFieldName[];
  matchedPayerId: string | null;
}

function fieldsOf(e: Extracted | null): { fields: CardFields; confidence: Confidence } {
  if (!e || e.status !== 'read' || !e.fields) return { fields: { ...EMPTY }, confidence: {} };
  return {
    fields: {
      ...EMPTY,
      ...e.fields,
      memberId: e.memberIdEncrypted ? decryptField(e.memberIdEncrypted) : null,
    },
    confidence: e.confidence ?? {},
  };
}

/** P-05 / W-14: what was read from a card, both sides together. A PHI read, audited. */
export async function cardForReview(
  db: Database,
  ctx: { tenantId: string; userId: string; documentId: string },
): Promise<CardReview | null> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [front] = await tx.select().from(documents).where(eq(documents.id, ctx.documentId));
    if (!front?.patientId) return null;
    const [back] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.storageKey, otherSide(front.storageKey)), ne(documents.id, front.id)));
    return withAudit(
      tx,
      {
        actor: `user:${ctx.userId}`,
        action: 'document.viewed',
        entityType: 'document',
        entityId: front.id,
        clientId: front.clientId,
        metadata: { purpose: 'card_review' },
      },
      async () => {
        const e = front.extracted as Extracted | null;
        const f = fieldsOf(e);
        const b = fieldsOf((back?.extracted ?? null) as Extracted | null);
        // The front decides; the back fills what the front does not show (RxBIN, phone).
        const fields = { ...f.fields };
        const confidence = { ...f.confidence };
        for (const k of Object.keys(EMPTY) as CardFieldName[])
          if (fields[k] == null && b.fields[k] != null) {
            fields[k] = b.fields[k];
            confidence[k] = b.confidence[k] ?? null;
          }
        const unsure = DECIDING_FIELDS.filter(
          (k) => fields[k] == null || (confidence[k] ?? 0) < LOW_CONFIDENCE,
        ) as CardFieldName[];
        return {
          documentId: front.id,
          backDocumentId: back?.id ?? null,
          patientId: front.patientId!,
          clientId: front.clientId,
          state: e ? e.status : 'reading',
          reviewStatus: front.reviewStatus,
          fields,
          confidence,
          unsure,
          matchedPayerId: e?.payerId ?? null,
        };
      },
    );
  });
}

export type ConfirmOutcome =
  | { ok: true; pmName: string | null; versionIds: string[]; corrected: string[]; coverageChanged: boolean }
  | { ok: false; reason: 'not_found' | 'not_read' | 'already_confirmed' | 'invalid'; message?: string };

/**
 * P-05 Confirm card / W-14 Confirm: the person's fields become the coverage (P-02's path, source
 * `card`), the card is accepted or corrected, and its W-14 item closes. What the person changed
 * from the reading is kept as corrections (training data, and future payer aliases).
 */
export async function confirmCard(
  db: Database,
  ctx: {
    tenantId: string;
    userId: string;
    documentId: string;
    coverageId: string;
    fields: { payerId: string; memberId: string; groupNumber: string };
    checkEligibility: boolean;
  },
): Promise<ConfirmOutcome> {
  const view = await cardForReview(db, ctx);
  if (!view) return { ok: false, reason: 'not_found' };
  if (view.state !== 'read') return { ok: false, reason: 'not_read' };
  if (view.reviewStatus !== 'pending') return { ok: false, reason: 'already_confirmed' };
  const pre = await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [cov] = await tx
      .select()
      .from(coverages)
      .where(and(eq(coverages.id, ctx.coverageId), eq(coverages.patientId, view.patientId)));
    const [payer] = await tx
      .select({ name: payers.name })
      .from(payers)
      .where(eq(payers.id, ctx.fields.payerId));
    return cov && payer ? { cov, payer } : null;
  });
  if (!pre) return { ok: false, reason: 'not_found' };
  const memberId = ctx.fields.memberId.trim().toUpperCase();
  const groupNumber = ctx.fields.groupNumber.trim();
  const corrected: string[] = [];
  if (ctx.fields.payerId !== view.matchedPayerId) corrected.push('payerName');
  if (memberId !== (view.fields.memberId ?? '').trim().toUpperCase()) corrected.push('memberId');
  if (groupNumber !== (view.fields.groupNumber ?? '').trim()) corrected.push('groupNumber');

  const res = await editCoverage(db, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    coverageId: ctx.coverageId,
    source: 'card',
    edit: {
      payerId: ctx.fields.payerId,
      memberId,
      groupNumber,
      relationship: pre.cov.relationship as 'self',
      priority: pre.cov.priority,
      effectiveDate: pre.cov.effectiveDate ?? '',
      terminationDate: pre.cov.terminationDate ?? '',
      checkEligibility: ctx.checkEligibility,
    },
  });
  if (!res.ok && res.reason !== 'no_change')
    return { ok: false, reason: 'invalid', ...(res.message ? { message: res.message } : {}) };

  const actor: AuditActor = `user:${ctx.userId}`;
  const now = clockNow();
  await withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const ids = [view.documentId, ...(view.backDocumentId ? [view.backDocumentId] : [])];
    await tx
      .update(documents)
      .set({ reviewStatus: corrected.length ? 'corrected' : 'accepted', updatedAt: now })
      .where(inArray(documents.id, ids));
    if (corrected.length)
      await tx.insert(corrections).values(
        corrected.map((f) => ({
          tenantId: ctx.tenantId,
          clientId: view.clientId,
          entityType: 'document',
          entityId: view.documentId,
          fieldPath: `card.${f}`,
          before:
            f === 'memberId'
              ? view.fields.memberId
                ? { encrypted: encryptField(view.fields.memberId) }
                : null
              : f === 'payerName'
                ? view.fields.payerName
                : view.fields.groupNumber,
          after:
            f === 'memberId'
              ? { encrypted: encryptField(memberId) }
              : f === 'payerName'
                ? pre.payer.name
                : groupNumber,
          userId: ctx.userId,
        })),
      );
    const open = await tx
      .select({ id: workItems.id, status: workItems.status })
      .from(workItems)
      .where(
        and(
          eq(workItems.documentId, view.documentId),
          eq(workItems.type, 'card_review'),
          ne(workItems.status, 'resolved'),
        ),
      );
    for (const item of open) {
      const next = state.nextWorkItemState(item.status as state.WorkItemState, 'resolve');
      if (!next.ok) continue;
      await tx
        .update(workItems)
        .set({
          status: next.value,
          resolvedBy: actor,
          resolution: corrected.length ? 'Fields corrected' : 'Fields confirmed',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(workItems.id, item.id));
    }
    await recordAudit(tx, {
      actor,
      action: 'document.confirmed',
      entityType: 'document',
      entityId: view.documentId,
      clientId: view.clientId,
      metadata: { corrected, coverageId: ctx.coverageId },
    });
  });
  return res.ok
    ? { ok: true, pmName: res.pmName, versionIds: res.versionIds, corrected, coverageChanged: true }
    : { ok: true, pmName: null, versionIds: [], corrected, coverageChanged: false };
}

/** P-04 Cancel: a card nobody confirmed is deleted, both sides and its W-14 item. */
export async function discardCard(
  db: Database,
  ctx: { tenantId: string; userId: string; documentId: string },
): Promise<boolean> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [front] = await tx.select().from(documents).where(eq(documents.id, ctx.documentId));
    if (!front || front.reviewStatus !== 'pending') return false;
    const docs = await tx
      .select()
      .from(documents)
      .where(or(eq(documents.id, front.id), eq(documents.storageKey, otherSide(front.storageKey))));
    for (const d of docs) {
      await tx.delete(workItems).where(eq(workItems.documentId, d.id));
      await deleteBlob(tx, d.storageKey);
      await tx.delete(documents).where(eq(documents.id, d.id));
    }
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'document.discarded',
      entityType: 'document',
      entityId: front.id,
      clientId: front.clientId,
      metadata: { sides: docs.length },
    });
    return true;
  });
}

/** The image of one side, for the signed image route (W-14 rule: every view audited). */
export async function cardImage(
  db: Database,
  ctx: { tenantId: string; userId: string; documentId: string },
): Promise<{ bytes: Uint8Array; contentType: string; clientId: string } | null> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [doc] = await tx.select().from(documents).where(eq(documents.id, ctx.documentId));
    if (!doc) return null;
    const blob = await withAudit(
      tx,
      {
        actor: `user:${ctx.userId}`,
        action: 'document.image_viewed',
        entityType: 'document',
        entityId: doc.id,
        clientId: doc.clientId,
        metadata: { type: doc.type },
      },
      () => readBlob(tx, doc.storageKey),
    );
    return blob ? { ...blob, clientId: doc.clientId } : null;
  });
}
