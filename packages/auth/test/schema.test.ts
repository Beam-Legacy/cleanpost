/** Our hand-written auth tables must hold every field better-auth and its plugins use. */
import { getAuthTables } from 'better-auth/db';
import { getTableColumns, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, passkeys, sessions, twoFactors, users, verifications } from '@cleanpost/db';
import { createAuth } from '../src';
import { memoryMailer } from '@cleanpost/email';

const TABLES: Record<string, Table> = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactors,
  passkey: passkeys,
};

describe('auth schema', () => {
  it('has a column for every better-auth field', () => {
    const auth = createAuth({
      db: {} as never,
      mailer: memoryMailer(),
      secret: 'x'.repeat(32),
      appUrl: 'http://localhost:3000',
    });
    const expected = getAuthTables(auth.options);
    const missing: string[] = [];
    for (const [model, def] of Object.entries(expected)) {
      if (model === 'rateLimit') continue; // memory rate limiting in M0
      const table = TABLES[model];
      if (!table) {
        missing.push(`table ${model}`);
        continue;
      }
      const cols = getTableColumns(table);
      for (const [field, attr] of Object.entries(def.fields)) {
        const key = (attr as { fieldName?: string }).fieldName ?? field;
        if (!(key in cols)) missing.push(`${model}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
