/**
 * Demo history (DEC-19): start the synthetic world over 90 days in the past, so the worker can
 * replay those days through the real pipeline (visits, claims, payments, people working the queue)
 * and the preview opens on a world that has been running for three months.
 *
 * The system role (CLAUDE.md rule 1: seeding), local and preview only. Kept: tenants, clients,
 * users and their sign-ins, memberships, connections (their sync starts over), rules,
 * mappings, payer settings, saved views and the audit log (append-only, so the earlier world's
 * events stay in it). Cleared: everything the PMs and payers produced and everything people did
 * with it.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@cleanpost/db';

export const DEMO_HISTORY_DAYS = 90;

/**
 * Raised when the replay changes enough that preview should build its history again: the release
 * step's `--if-new` starts over a history built by an older version (once).
 * 2: daily visits carry defects; the simulated billers fix, correct and resubmit, and close old work.
 * 3: corrections that drop a line reach the PM; pointer blocks fixed by hand; billed ones let go.
 * 4: the sync carries on when the PM removes a charge line a claim in review still has.
 */
export const DEMO_HISTORY_VERSION = 4;

/** Tables holding what the PMs and payers produced and what people did with it. */
const ACTIVITY_TABLES = [
  'write_off_requests',
  'manual_tasks',
  'work_items',
  'notifications',
  'corrections',
  'scrub_results',
  'claim_events',
  'claim_lines',
  'claim_versions',
  'remit_remarks',
  'remit_adjustments',
  'remit_lines',
  'remit_claims',
  'provider_adjustments',
  'remittances',
  'pm_postings',
  'postings',
  'claims',
  'charge_lines',
  'diagnoses',
  'encounters',
  'eligibility_checks',
  'documents',
  'coverages',
  'patients',
  'exports',
  'usage_records',
  'sync_runs',
  'rate_limit_buckets',
] as const;

/**
 * The clock offset that puts demo time at 9 am Pacific `days` ago, so the simulated work happens in
 * office hours (each replay day is exactly 24 hours).
 */
export function demoStartOffset(days = DEMO_HISTORY_DAYS, realNow = Date.now()): number {
  const pt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
  const date = pt.format(new Date(realNow - days * 86_400_000)); // YYYY-MM-DD
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const hourIn = (ms: number) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(new Date(ms)),
    );
  // 9 am Pacific is 16:00 UTC in summer time and 17:00 in winter.
  const summer = Date.UTC(y, m - 1, d, 16);
  const start = hourIn(summer) === 9 ? summer : summer + 3_600_000;
  return start - realNow;
}

export function demoHistoryAllowed(env = process.env.CLEANPOST_ENV ?? 'local'): boolean {
  return env === 'local' || env === 'preview';
}

/**
 * Clears the activity, starts every connection's sync over and moves the clock `days` back, with
 * the replay pending for the worker. Run after the payer simulator and the mock PM were reset.
 */
export async function wipeForDemoHistory(
  db: Database,
  opts: { days?: number; offsetMs?: number } = {},
): Promise<void> {
  const days = opts.days ?? DEMO_HISTORY_DAYS;
  const offsetMs = opts.offsetMs ?? demoStartOffset(days);
  if (!demoHistoryAllowed()) throw new Error('demo history is only available in local and preview');
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`truncate ${ACTIVITY_TABLES.map((t) => `public.${t}`).join(', ')}`));
    // PM ids of the records just cleared; the practices' locations keep theirs.
    await tx.execute(sql`delete from external_refs where entity_type not in ('location', 'provider')`);
    // Sync starts over (status is left to the connection state machine on the next sync).
    await tx.execute(sql`update connections set last_success_at = null, next_run_at = null,
      consecutive_failed_cycles = 0`);
    // Jobs queued for the records just cleared.
    await tx.execute(sql`delete from pgboss.job where state in ('created', 'retry')
      and name not like '\\_\\_pgboss%'`);
    await tx.execute(sql`update app.clock set enabled = true, offset_ms = ${Math.trunc(offsetMs)},
      updated_at = now(),
      demo = jsonb_build_object('state', 'pending', 'days', ${days}::int, 'day', 0,
        'version', ${DEMO_HISTORY_VERSION}::int, 'requestedAt', to_jsonb(now()))
      where id = 1`);
  });
}
