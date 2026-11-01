/**
 * API keys for mock PM accounts. Preview and local derive each account's key from one secret
 * (PM_MOCK_SECRET), so the seed, pm-mock and Cleanpost's development secret resolver agree without
 * passing keys around. Only the hash is stored.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const apiKeyFor = (secret: string, accountId: string): string =>
  createHmac('sha256', secret).update(`pm-mock:${accountId}`).digest('base64url');

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
