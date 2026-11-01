import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src';
import { TEST_DATABASE_ADMIN_URL } from './env';

const admin = createDatabase(TEST_DATABASE_ADMIN_URL, { max: 1 });
afterAll(() => admin.close());

describe('uuidv7() SQL function', () => {
  it('returns version 7, RFC 4122 variant UUIDs carrying the current time', async () => {
    const before = Date.now();
    const { rows } = await admin.pool.query<{ id: string }>('select uuidv7()::text as id');
    const id = rows[0]!.id;
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(Math.abs(ms - before)).toBeLessThan(5_000);
  });
});
