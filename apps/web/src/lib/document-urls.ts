import 'server-only';
/**
 * Short-lived links to a document image (W-14 rule: images leave encrypted storage only through
 * short-lived signed URLs). The link names the document and the person it was made for and expires
 * after five minutes; the route also needs that person's session. The key is derived from the
 * field key, with a label so it signs nothing else.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 5 * 60_000;

function sign(documentId: string, userId: string, expires: number): string {
  const key = Buffer.from(process.env.FIELD_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be set');
  return createHmac('sha256', key)
    .update(`document-url:v1:${documentId}:${userId}:${expires}`)
    .digest('base64url');
}

export function documentUrl(documentId: string, userId: string): string {
  // Real time, not demo time: a link must expire for real.
  const expires = Date.now() + TTL_MS;
  return `/api/documents/${documentId}?e=${expires}&s=${sign(documentId, userId, expires)}`;
}

export function verifyDocumentUrl(documentId: string, userId: string, e: string | null, s: string | null) {
  const expires = Number(e);
  if (!e || !s || !Number.isFinite(expires) || expires < Date.now()) return false;
  const want = Buffer.from(sign(documentId, userId, expires));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got);
}
