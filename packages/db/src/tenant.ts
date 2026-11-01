import { sql } from 'drizzle-orm';
import type { Database, Tx } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  tenantId: string;
  /** The signed-in user, if any. Jobs run without one. */
  userId?: string | null;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

function assertUuid(value: string, field: string) {
  if (!UUID_RE.test(value)) throw new TenantContextError(`${field} must be a UUID`);
}

/**
 * Runs `fn` in a transaction scoped to one tenant (CLAUDE.md rule 1). RLS policies read
 * app.tenant_id and app.user_id, which are set with set_config(..., true) and so end with the
 * transaction: nothing leaks to the next use of the pooled connection.
 */
export async function withTenant<T>(
  db: Database,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.tenantId, 'tenantId');
  if (ctx.userId) assertUuid(ctx.userId, 'userId');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Runs `fn` for a signed-in user before a company is chosen (A-07). Tenant tables return nothing
 * except the user's own memberships and the names of those tenants.
 */
export async function withUser<T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(userId, 'userId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
