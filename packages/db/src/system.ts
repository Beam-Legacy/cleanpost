/**
 * The system role: the table owner, which bypasses RLS. Only migrations, seeding and the platform
 * admin service may use it (CLAUDE.md rule 1). Importing `@cleanpost/db/system` anywhere else is a
 * review blocker; keep the import path distinct so it is easy to find.
 */
import { z } from 'zod';
import { parseEnv } from '@cleanpost/config';
import { createDatabase, type DatabaseHandle } from './client';

export function createSystemDatabase(url?: string): DatabaseHandle {
  const adminUrl = url ?? parseEnv(z.object({ DATABASE_ADMIN_URL: z.string().min(1) })).DATABASE_ADMIN_URL;
  return createDatabase(adminUrl, { max: 2 });
}
