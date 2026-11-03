import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOffset, setOffset } from '@cleanpost/clock';
import { createDatabase, setDemoOffset, syncClock, type DatabaseHandle } from '../src';
import { testDatabaseUrls } from '../src/testing';

/**
 * DEC-18 demo time. Other suites share this database, so nothing here leaves the clock moved:
 * changes as the owner happen inside a transaction that rolls back.
 */
const { adminUrl, url } = testDatabaseUrls();
let admin: DatabaseHandle;
let app: DatabaseHandle;

beforeAll(() => {
  admin = createDatabase(adminUrl, { max: 1 });
  app = createDatabase(url, { max: 1 });
});

afterAll(async () => {
  setOffset(0);
  await app.close();
  await admin.close();
});

class Rollback extends Error {}

describe('app.clock', () => {
  it('app.now() follows the offset only once demo time is enabled', async () => {
    const seen: number[] = [];
    await admin.db
      .transaction(async (tx) => {
        const drift = async () => {
          const r = await tx.execute<{ ms: string }>(
            sql`select (extract(epoch from app.now() - now()) * 1000)::bigint as ms`,
          );
          return Number(r.rows[0]!.ms);
        };
        await tx.execute(sql`update app.clock set offset_ms = 86400000 where id = 1`);
        seen.push(await drift());
        await tx.execute(sql`update app.clock set enabled = true where id = 1`);
        seen.push(await drift());
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(seen).toEqual([0, 86_400_000]);
  });

  it('the app role can move the offset but cannot enable demo time', async () => {
    // 42501: insufficient privilege (UPDATE is granted on offset_ms and updated_at only).
    await expect(app.db.execute(sql`update app.clock set enabled = true where id = 1`)).rejects.toMatchObject(
      {
        cause: { code: '42501' },
      },
    );
    await expect(setDemoOffset(app.db, 3_600_000)).rejects.toThrow('demo time is not enabled');
    expect(getOffset()).toBe(0);
  });

  it('reads a stored offset as zero where demo time is off', async () => {
    setOffset(5_000);
    expect(await syncClock(app.db)).toBe(0);
  });
});
