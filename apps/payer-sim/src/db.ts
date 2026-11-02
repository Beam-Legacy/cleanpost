import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type SimDb = NodePgDatabase<typeof schema>;

export interface SimDbHandle {
  db: SimDb;
  close(): Promise<void>;
}

export function createSimDb(url: string, max = 5): SimDbHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** payer-sim keeps its own migrations table inside its own schema. */
export async function migrateSimDb(url: string): Promise<void> {
  const h = createSimDb(url, 1);
  try {
    await migrate(h.db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: 'payer_sim',
      migrationsTable: '__migrations',
    });
  } finally {
    await h.close();
  }
}
