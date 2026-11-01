import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type PmDb = NodePgDatabase<typeof schema>;

export interface PmDbHandle {
  db: PmDb;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createPmDb(url: string, max = 5): PmDbHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** pm-mock keeps its own migrations table inside its own schema, apart from Cleanpost's. */
export async function migratePmDb(url: string): Promise<void> {
  const h = createPmDb(url, 1);
  try {
    await migrate(h.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: 'pm_mock',
      migrationsTable: '__migrations',
    });
  } finally {
    await h.close();
  }
}
