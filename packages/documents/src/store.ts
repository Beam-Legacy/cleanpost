/**
 * Document contents (DEC-31). In local and preview they live in `document_blobs`, encrypted with
 * the field key before they reach the database; production keeps them in S3 with SSE-KMS behind the
 * same three calls. Contents never pass through logs, job payloads or URLs.
 */
import { eq } from 'drizzle-orm';
import { decryptBytes, documentBlobs, encryptBytes, type Tx } from '@cleanpost/db';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The image type from the file's first bytes (never from its name or the browser's word). */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (i: number, ...b: number[]) => b.every((x, k) => bytes[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

export async function putBlob(
  tx: Tx,
  b: { tenantId: string; clientId: string | null; key: string; contentType: string; bytes: Uint8Array },
) {
  await tx.insert(documentBlobs).values({
    tenantId: b.tenantId,
    clientId: b.clientId,
    storageKey: b.key,
    contentType: b.contentType,
    sizeBytes: b.bytes.length,
    contentEncrypted: encryptBytes(b.bytes),
  });
}

export async function readBlob(
  tx: Tx,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const [row] = await tx.select().from(documentBlobs).where(eq(documentBlobs.storageKey, key));
  return row ? { bytes: decryptBytes(row.contentEncrypted), contentType: row.contentType } : null;
}

export async function deleteBlob(tx: Tx, key: string) {
  await tx.delete(documentBlobs).where(eq(documentBlobs.storageKey, key));
}
