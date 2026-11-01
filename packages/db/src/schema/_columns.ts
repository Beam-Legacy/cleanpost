import { sql } from 'drizzle-orm';
import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Primary key: UUIDv7. The app generates it; raw SQL (seeds, system tasks) gets the same from the
 * uuidv7() SQL function defined in the first migration (Postgres 16 has no built-in uuidv7()).
 */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`)
    .$defaultFn(() => uuidv7());

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Every customer-data table carries tenant_id; RLS policies check it (docs/02-data-model.md). */
export const tenantId = () => uuid('tenant_id').notNull();

/** Rows scoped to a practice carry both tenant_id and client_id. */
export const clientId = () => uuid('client_id').notNull();

/** Money is integer cents (CLAUDE.md rule 5). JS numbers hold cents exactly up to $90 trillion. */
export const cents = (name: string) => bigint(name, { mode: 'number' });
