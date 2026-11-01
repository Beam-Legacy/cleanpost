/**
 * What the registry gives adapters (docs/05-adapters.md): credentials by reference, and a shared
 * rate limiter keyed by PM account and endpoint, so every worker respects the same PM limit.
 */
import { createHmac } from 'node:crypto';
import type { Connection } from './contract';
import { AdapterError } from './results';

export interface SecretResolver {
  /** The secret a connection's credentials_secret_ref points to. Throws AUTH_FAILED when missing. */
  resolve(ref: string): Promise<string>;
}

export interface RateLimiter {
  /**
   * Waits for a token in the bucket for (key, endpoint), refilled at `perSecond`. Rejects with a
   * retryable RATE_LIMITED AdapterError if the wait would be longer than `maxWaitMs`.
   */
  acquire(conn: Connection, endpoint: string, perSecond: number, maxWaitMs?: number): Promise<void>;
}

/** Connections in one PM account share a bucket; others get their own. */
export const rateLimitKey = (conn: Connection) => conn.pmAccountRef ?? `connection:${conn.id}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-process limiter for tests and single-process tools. Workers use the Postgres limiter in packages/sync. */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    async acquire(conn, endpoint, perSecond, maxWaitMs = 30_000) {
      const key = `${rateLimitKey(conn)}|${endpoint}`;
      const deadline = now() + maxWaitMs;
      for (;;) {
        const t = now();
        const b = buckets.get(key) ?? { tokens: Math.max(1, perSecond), at: t };
        const tokens = Math.min(Math.max(1, perSecond), b.tokens + ((t - b.at) / 1000) * perSecond);
        if (tokens >= 1) {
          buckets.set(key, { tokens: tokens - 1, at: t });
          return;
        }
        buckets.set(key, { tokens, at: t });
        const wait = Math.ceil(((1 - tokens) / perSecond) * 1000);
        if (t + wait > deadline) throw new AdapterError('RATE_LIMITED', true, 'The PM rate limit is in use');
        await sleep(wait);
      }
    },
  };
}

/** No limit at all, for unit tests of mapping. */
export const unlimited: RateLimiter = { acquire: async () => {} };

/**
 * Development and preview secrets: `pm-mock:<account>` derives the mock PM account's key from
 * PM_MOCK_SECRET (same derivation as apps/pm-mock src/keys.ts); `env:<NAME>` reads a variable.
 * Production resolves references from the secrets manager instead (M6).
 */
export function createDevSecretResolver(opts: {
  pmMockSecret?: string;
  env?: Record<string, string | undefined>;
}): SecretResolver {
  return {
    async resolve(ref) {
      const [scheme, name] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
      if (scheme === 'pm-mock' && opts.pmMockSecret && name) {
        return createHmac('sha256', opts.pmMockSecret).update(`pm-mock:${name}`).digest('base64url');
      }
      if (scheme === 'env' && name && opts.env?.[name]) return opts.env[name]!;
      throw new AdapterError('AUTH_FAILED', false, 'No saved credentials were found for this connection');
    },
  };
}
