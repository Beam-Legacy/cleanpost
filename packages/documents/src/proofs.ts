/**
 * W-22 Document proof of timely filing: a clearinghouse acceptance report, a payer letter or a
 * screenshot that the claim reached the payer in time. Stored like a card photo (encrypted, DEC-31)
 * and linked to the timely-filing item; the caller resolves the item.
 */
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { claims, documents, recordAudit, withTenant, workItems, type Database } from '@cleanpost/db';
import { MAX_DOCUMENT_BYTES, putBlob, sniffImage } from './store';

const isPdf = (b: Uint8Array) =>
  b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

export type ProofOutcome =
  | { ok: true; documentId: string }
  | { ok: false; reason: 'not_found' | 'too_large' | 'not_a_document' | 'empty' };

export async function uploadFilingProof(
  db: Database,
  ctx: { tenantId: string; userId: string; itemId: string },
  bytes: Uint8Array,
): Promise<ProofOutcome> {
  if (!bytes.length) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' };
  const contentType = isPdf(bytes) ? 'application/pdf' : sniffImage(bytes);
  if (!contentType) return { ok: false, reason: 'not_a_document' };
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [item] = await tx.select().from(workItems).where(eq(workItems.id, ctx.itemId));
    if (!item?.claimId || item.type !== 'timely_filing_risk') return { ok: false, reason: 'not_found' };
    const [claim] = await tx
      .select({ clientId: claims.clientId, patientId: claims.patientId })
      .from(claims)
      .where(eq(claims.id, item.claimId));
    if (!claim) return { ok: false, reason: 'not_found' };
    const key = `proofs/${uuidv7()}`;
    await putBlob(tx, { tenantId: ctx.tenantId, clientId: claim.clientId, key, contentType, bytes });
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId: ctx.tenantId,
        clientId: claim.clientId,
        patientId: claim.patientId,
        type: 'timely_filing_proof',
        storageKey: key,
        reviewStatus: 'accepted',
      })
      .returning({ id: documents.id });
    await tx.update(workItems).set({ documentId: doc!.id }).where(eq(workItems.id, item.id));
    await recordAudit(tx, {
      actor: `user:${ctx.userId}`,
      action: 'document.uploaded',
      entityType: 'document',
      entityId: doc!.id,
      clientId: claim.clientId,
      metadata: { type: 'timely_filing_proof', sizeBytes: bytes.length, contentType, claimId: item.claimId },
    });
    return { ok: true, documentId: doc!.id };
  });
}
