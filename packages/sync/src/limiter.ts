/**
 * Postgres-backed token buckets for PM rate limits (docs/05-adapters.md). Every worker takes tokens
 * from the same row, so connections that share a PM account (pm_account_ref) share its limit no
 * matter which process runs them. Each take is its own short tenant transaction.
 */
import { sql } from 'drizzle-orm';
import { AdapterError, rateLimitKey, type RateLimiter } from '@cleanpost/adapters';
import { withTenant, type Database } from '@cleanpost/db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPgRateLimiter(db: Database): RateLimiter {
  return {
    async acquire(conn, endpoint, perSecond, maxWaitMs = 30_000) {
      const key = rateLimitKey(conn);
      const cap = Math.max(1, perSecond);
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        const waitMs = await withTenant(db, { tenantId: conn.tenantId }, async (tx) => {
          const refill = sql`least(${cap}::float8, b.tokens + extract(epoch from clock_timestamp() - b.refilled_at)::float8 * ${perSecond}::float8)`;
          const taken = await tx.execute(sql`
            insert into rate_limit_buckets as b (tenant_id, key, endpoint, tokens, refilled_at)
            values (${conn.tenantId}, ${key}, ${endpoint}, ${cap - 1}::float8, clock_timestamp())
            on conflict (tenant_id, key, endpoint) do update
              set tokens = ${refill} - 1, refilled_at = clock_timestamp(), updated_at = clock_timestamp()
              where ${refill} >= 1
            returning b.tokens`);
          if (taken.rows.length) return 0;
          const current = await tx.execute<{ tokens: number }>(sql`
            select ${refill} as tokens from rate_limit_buckets b
            where b.tenant_id = ${conn.tenantId} and b.key = ${key} and b.endpoint = ${endpoint}`);
          const tokens = Number(current.rows[0]?.tokens ?? 0);
          return Math.max(10, Math.ceil(((1 - tokens) / perSecond) * 1000));
        });
        if (waitMs === 0) return;
        if (Date.now() + waitMs > deadline) {
          throw new AdapterError('RATE_LIMITED', true, 'The PM rate limit is in use');
        }
        await sleep(waitMs);
      }
    },
  };
}
