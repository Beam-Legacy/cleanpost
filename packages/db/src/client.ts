import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { dbEnvSchema, parseEnv } from '@cleanpost/config';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
/** A transaction handle; tenant-scoped work always receives one of these. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

let shared: DatabaseHandle | undefined;

/** The app database, connected as the non-owner role from DATABASE_URL, so RLS always applies. */
export function getDatabase(): Database {
  shared ??= createDatabase(parseEnv(dbEnvSchema).DATABASE_URL);
  return shared.db;
}
