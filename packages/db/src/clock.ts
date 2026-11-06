/**
 * Demo time in the database (DEC-18): app.clock holds the offset every Cleanpost process follows,
 * and app.now() applies it to business timestamps. Two locks keep it to local and preview: the
 * clock is only enabled by the synthetic seed (system role), and a non-zero offset is refused, and
 * read as zero, anywhere else.
 */
import { sql } from 'drizzle-orm';
import { demoTimeAllowed, getOffset, setOffset } from '@cleanpost/clock';
import type { Database } from './client';

/** Reads the shared offset into this process. Returns it (always 0 outside local and preview). */
export async function syncClock(db: Database): Promise<number> {
  const res = await db.execute<{ offset_ms: string | number }>(
    sql`select case when enabled then offset_ms else 0 end as offset_ms from app.clock where id = 1`,
  );
  const ms = Number(res.rows[0]?.offset_ms ?? 0);
  setOffset(demoTimeAllowed() ? ms : 0);
  return getOffset();
}

/**
 * Sets demo time for every process (each picks it up within seconds) and for this one at once.
 * Refused outside local and preview, and where the seed has not enabled demo time.
 */
export async function setDemoOffset(db: Database, ms: number): Promise<void> {
  const offset = Math.trunc(ms);
  if (!Number.isFinite(offset)) throw new Error('clock offset must be a number of milliseconds');
  if (offset !== 0 && !demoTimeAllowed()) throw new Error('demo time is only available in local and preview');
  const res = await db.execute<{ id: number }>(
    sql`update app.clock set offset_ms = ${offset}, updated_at = now() where id = 1 and enabled returning id`,
  );
  if (res.rows.length === 0 && offset !== 0) throw new Error('demo time is not enabled on this database');
  setOffset(offset);
}

/** A cheap per-request refresh: reads the offset at most once per interval. */
export function clockSyncer(db: Database, intervalMs = 2000): () => Promise<void> {
  let last = 0;
  return async () => {
    if (Date.now() - last < intervalMs) return;
    last = Date.now();
    await syncClock(db).catch(() => undefined);
  };
}

export type DemoHistoryState = 'pending' | 'running' | 'done' | 'failed';

/** The 90-day replay's progress (DEC-19); `{}` when no history was ever built. */
export interface DemoHistory {
  state?: DemoHistoryState;
  /** The replay's version when this history was started (DEMO_HISTORY_VERSION). */
  version?: number;
  days?: number;
  /** Days replayed so far. */
  day?: number;
  requestedAt?: string;
  startedAt?: string;
  /** The replaying process's last sign of life; a replay silent for minutes is taken over. */
  beatAt?: string;
  finishedAt?: string;
  /** Why it failed (no patient data). */
  error?: string;
}

export async function readDemoHistory(db: Database): Promise<DemoHistory> {
  const res = await db.execute<{ demo: DemoHistory }>(sql`select demo from app.clock where id = 1`);
  return res.rows[0]?.demo ?? {};
}

/**
 * Takes a pending replay for this process, or one whose process went quiet (a worker restarted
 * mid-replay: it carries on from the clock's date). Null when there is nothing to take.
 */
export async function claimDemoHistory(db: Database, staleAfterMs = 5 * 60_000): Promise<DemoHistory | null> {
  const res = await db.execute<{ demo: DemoHistory }>(
    sql`update app.clock
        set demo = demo || jsonb_build_object('state', 'running', 'beatAt', to_jsonb(now()))
          || case when demo->>'state' = 'pending' then jsonb_build_object('startedAt', to_jsonb(now()))
             else '{}'::jsonb end
        where id = 1 and enabled and (demo->>'state' = 'pending' or (demo->>'state' = 'running'
          and coalesce(demo->>'beatAt', demo->>'startedAt')::timestamptz
            < now() - make_interval(secs => ${staleAfterMs / 1000})))
        returning demo`,
  );
  return res.rows[0]?.demo ?? null;
}

export async function reportDemoHistory(db: Database, patch: DemoHistory): Promise<void> {
  await db.execute(sql`update app.clock set demo = demo || ${JSON.stringify(patch)}::jsonb where id = 1`);
}
