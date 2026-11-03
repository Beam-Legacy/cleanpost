/**
 * The system role: the table owner, which bypasses RLS. Only migrations, seeding and the platform
 * admin service may use it (CLAUDE.md rule 1). Importing `@cleanpost/db/system` anywhere else is a
 * review blocker; keep the import path distinct so it is easy to find.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createDatabase, type DatabaseHandle } from './client';

export function createSystemDatabase(url?: string): DatabaseHandle {
  const adminUrl = url ?? parseEnv(z.object({ DATABASE_ADMIN_URL: z.string().min(1) })).DATABASE_ADMIN_URL;
  return createDatabase(adminUrl, { max: 2 });
}

/**
 * Turns demo time on for this database (DEC-18). Only the synthetic seed calls it, in local and
 * preview; staging and production never enable it, so app.now() there is always now().
 */
export async function enableDemoTime(db: DatabaseHandle['db']): Promise<void> {
  await db.execute(sql`update app.clock set enabled = true where id = 1`);
}
