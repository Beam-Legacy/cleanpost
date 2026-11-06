/**
 * Field-level encryption for tax IDs and member IDs (docs/11-security-hipaa.md). AES-256-GCM with a
 * key from FIELD_ENCRYPTION_KEY (32 bytes, base64); production loads it from the secrets manager.
 * Format: v1:<iv>:<tag>:<ciphertext>, all base64. The version prefix allows key rotation later.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCryptoError';
  }
}

function key(source: Record<string, string | undefined> = process.env): Buffer {
  const { FIELD_ENCRYPTION_KEY } = parseEnv(z.object({ FIELD_ENCRYPTION_KEY: z.string().min(40) }), source);
  const k = Buffer.from(FIELD_ENCRYPTION_KEY, 'base64');
  if (k.length !== 32) throw new FieldCryptoError('FIELD_ENCRYPTION_KEY must be 32 bytes, base64');
  return k;
}

export function encryptField(plain: string, source?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(source), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(
    ':',
  );
}

export function decryptField(stored: string, source?: Record<string, string | undefined>): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new FieldCryptoError('unknown field encryption format');
  const decipher = createDecipheriv('aes-256-gcm', key(source), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Document contents (card images, DEC-31): the same scheme over raw bytes. */
export function encryptBytes(plain: Uint8Array, source?: Record<string, string | undefined>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(source), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(
    ':',
  );
}

export function decryptBytes(stored: string, source?: Record<string, string | undefined>): Uint8Array {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ct) throw new FieldCryptoError('unknown field encryption format');
  const decipher = createDecipheriv('aes-256-gcm', key(source), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]));
}

/** Last four characters for masked display, e.g. "•••••2210" (C-06). */
export const last4 = (value: string) => value.slice(-4);
