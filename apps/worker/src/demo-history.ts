/**
 * Demo history (DEC-19): after `pnpm demo:reset` the world stands 90 days back. The worker replays
 * those days through the real pipeline so the preview opens on three months of work:
 *
 *   each day      the practices enter the day's visits in the mock PM; the clock moves a day
 *   each step     sync -> build, eligibility, scrub; simulated billers work the queue; the PM's
 *                 clearinghouse sends, the payer answers (277CA, 835); Tebra 835s are uploaded as a
 *                 biller would; sync again; the daily follow-up sweep
 *
 * Steps are three days apart until the last two weeks, then daily, and the last one lands on today.
 * The simulated billers are the seeded users (their actions are recorded as theirs, as a demo
 * needs), deterministic by item and day. They do the routine work: approve reviews, void
 * duplicates, write off small denials, map new adjustment codes and upload Tebra 835s. Fixes,
 * corrected claims, posting differences and eligibility problems are left as the open backlog.
 * Local and preview only; IDs only in the logs.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { approveClaim, voidClaim, writeOffClaim } from '@cleanpost/claims';
import { getOffset, now as clockNow } from '@cleanpost/clock';
import {
  adjustmentMappings,
  claimDemoHistory,
  claims,
  connections,
  memberships,
  reportDemoHistory,
  setDemoOffset,
  users,
  withTenant,
  workItems,
  type Database,
} from '@cleanpost/db';
import { JOBS, sendClaimRelease, sendSyncPull } from '@cleanpost/jobs';
import type { Logger } from '@cleanpost/log';
import { ingestInTx, saveMapping, verifyInTx } from '@cleanpost/remit';
import { listCandidates } from '@cleanpost/sync';
import type { WorkerDeps } from './handlers';
import { parse835 } from '@cleanpost/x12';

const DAY = 86_400_000;

/** D-03's default: the denied amount, capped at the claim's balance. */
const writeOffDefaultCents = (denied: number, balance: number) => Math.max(0, Math.min(denied, balance));

export interface HistoryDeps {
  db: Database;
  boss: WorkerDeps['boss'];
  log: Logger;
  pmMock: { url: string; adminPassword: string };
  payerSim: { url: string; token?: string };
  /** The daily follow-up sweep (the worker's own handler). */
  sweep: () => Promise<unknown>;
}

interface MockConnection {
  tenantId: string;
  connectionId: string;
  clientId: string;
  practiceId: string;
  /** Tebra has no ERA API: its 835s are downloaded from the PM and uploaded. */
  uploadsEras: boolean;
}

interface Staff {
  admins: string[];
  billers: { userId: string; clientIds: string[] | 'all' }[];
}

/** A stable yes/no for this key: the same item decides the same way on the same day. */
function chance(key: string, p: number): boolean {
  const h = createHash('sha256').update(key).digest().readUInt32BE(0);
  return h / 0xffff_ffff < p;
}

function pick<T>(key: string, list: readonly T[]): T | undefined {
  if (!list.length) return undefined;
  const h = createHash('sha256').update(key).digest().readUInt32BE(0);
  return list[h % list.length];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isWeekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

export function createHistoryRunner(deps: HistoryDeps) {
  const pmAuth = `Basic ${Buffer.from(`admin:${deps.pmMock.adminPassword}`).toString('base64')}`;
  const simHeaders: Record<string, string> = deps.payerSim.token
    ? { authorization: `Bearer ${deps.payerSim.token}` }
    : {};
  const lastEra = new Map<string, string>();

  async function pm(path: string, init: RequestInit = {}) {
    const res = await fetch(`${deps.pmMock.url}${path}`, {
      ...init,
      headers: { authorization: pmAuth, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`pm-mock ${path.split('?')[0]} answered ${res.status}`);
    return res.json() as Promise<unknown>;
  }

  /** Moves the payer simulator's clock, and Cleanpost with it; the PM follows on its next call. */
  async function advance(minutes: number) {
    const res = await fetch(`${deps.payerSim.url}/clock/advance?minutes=${minutes}`, {
      method: 'POST',
      headers: simHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`payer-sim refused the clock change: ${res.status}`);
    const { now } = (await res.json()) as { now: string };
    const offset = Date.parse(now) - Date.now();
    // Within a minute of today: today exactly.
    await setDemoOffset(deps.db, offset > -60_000 ? 0 : offset);
  }

  /** Until no job that is due is waiting, running or retrying (scheduled ticks aside). */
  async function quiet(timeoutMs = 15 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (let calm = 0; calm < 3;) {
      const res = await deps.db.execute<{ n: number }>(sql`
        select count(*)::int as n from pgboss.job
        where state in ('created', 'retry', 'active') and start_after <= now()
          and name not in (${JOBS.syncTick}, ${JOBS.claimStatusSweep}) and name not like '\\_\\_pgboss%'`);
      calm = res.rows[0]!.n === 0 ? calm + 1 : 0;
      if (Date.now() > deadline) throw new Error('the job queue did not go quiet');
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function mockConnections(): Promise<MockConnection[]> {
    const out: MockConnection[] = [];
    for (const c of await listCandidates(deps.db)) {
      const [row] = await withTenant(deps.db, { tenantId: c.tenantId }, (tx) =>
        tx.select().from(connections).where(eq(connections.id, c.connectionId)),
      );
      const settings = (row?.settings ?? {}) as { practiceId?: string; profile?: string };
      if (row?.adapterKey !== 'mock' || !settings.practiceId) continue;
      out.push({
        tenantId: c.tenantId,
        connectionId: row.id,
        clientId: row.clientId,
        practiceId: settings.practiceId,
        uploadsEras: settings.profile === 'tebra',
      });
    }
    return out;
  }

  async function staffOf(tenantId: string): Promise<Staff> {
    const rows = await withTenant(deps.db, { tenantId }, (tx) =>
      tx
        .select({ m: memberships, status: users.status })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)),
    );
    const active = rows.filter((r) => r.status === 'active');
    return {
      // Admins other than the owner map codes; the owner is the one giving the demo.
      admins: active.filter((r) => r.m.role === 'admin' && !r.m.isOwner).map((r) => r.m.userId),
      billers: active
        .filter((r) => r.m.role === 'biller')
        .map((r) => ({
          userId: r.m.userId,
          clientIds: r.m.clientScope === 'all' ? ('all' as const) : (r.m.clientIds ?? []),
        })),
    };
  }

  const billerFor = (staff: Staff, clientId: string | null, key: string) =>
    pick(
      key,
      staff.billers
        .filter((b) => b.clientIds === 'all' || (clientId !== null && b.clientIds.includes(clientId)))
        .map((b) => b.userId),
    );

  async function syncAll(conns: MockConnection[]) {
    for (const c of conns)
      await sendSyncPull(deps.boss, {
        tenantId: c.tenantId,
        connectionId: c.connectionId,
        trigger: 'manual',
      });
    await quiet();
  }

  /** The billers' day: routine items, a day or more old, most of the time. */
  async function workTheQueue(tenantId: string, staff: Staff, day: string) {
    const now = clockNow();
    const settled = new Date(now.getTime() - 18 * 3_600_000);
    const open = await withTenant(deps.db, { tenantId }, (tx) =>
      tx
        .select({ item: workItems, claimStatus: claims.status, balance: claims.balanceCents })
        .from(workItems)
        .leftJoin(claims, eq(claims.id, workItems.claimId))
        .where(
          and(
            ne(workItems.status, 'resolved'),
            lt(workItems.createdAt, settled),
            inArray(workItems.type, ['claim_review', 'claim_blocked', 'denial', 'mapping_needed']),
          ),
        ),
    );
    const done = { approved: 0, voided: 0, writtenOff: 0, mapped: 0 };
    for (const { item, claimStatus, balance } of open) {
      const key = `${item.id}:${day}`;
      const biller = billerFor(staff, item.clientId, key);
      if (!biller || !item.claimId) continue;
      if (item.type === 'claim_review' && claimStatus === 'needs_review' && chance(key, 0.88)) {
        const res = await approveClaim(deps.db, { tenantId, userId: biller, claimId: item.claimId });
        if (res.ok) {
          await sendClaimRelease(deps.boss, { tenantId, claimId: item.claimId, userId: biller });
          done.approved++;
        }
      } else if (
        item.type === 'claim_blocked' &&
        item.reasonCode === 'history.duplicate' &&
        chance(key, 0.7)
      ) {
        const res = await voidClaim(deps.db, {
          tenantId,
          userId: biller,
          claimId: item.claimId,
          reason: 'Duplicate',
        });
        if (res.ok) done.voided++;
      } else if (
        item.type === 'claim_blocked' &&
        item.reasonCode.startsWith('eligibility.') &&
        now.getTime() - item.createdAt.getTime() > 4 * DAY &&
        chance(key, 0.3)
      ) {
        // Coverage the payer does not know or has ended: the practice bills the patient instead.
        const res = await voidClaim(deps.db, {
          tenantId,
          userId: biller,
          claimId: item.claimId,
          reason: 'Patient will pay',
        });
        if (res.ok) done.voided++;
      } else if (
        item.type === 'denial' &&
        (item.amountCents ?? 0) > 0 &&
        (item.amountCents ?? 0) <= 15_000 &&
        now.getTime() - item.createdAt.getTime() > 3 * DAY &&
        chance(key, 0.35)
      ) {
        const res = await writeOffClaim(
          deps.db,
          { tenantId, userId: biller, claimId: item.claimId, overLimit: 'refused' },
          {
            amountCents: writeOffDefaultCents(item.amountCents ?? 0, Number(balance ?? 0)),
            reason: 'Not worth pursuing',
            note: null,
            pmCode: await writeOffCode(tenantId, item.clientId),
            denialItemId: item.id,
          },
        );
        if (res.status === 'written_off') done.writtenOff++;
      }
    }
    // New adjustment codes: an admin maps each once, from what the PM posted for the same amounts.
    const admin = pick(day, staff.admins);
    const pairs = new Map(
      open
        .filter((o) => o.item.type === 'mapping_needed' && o.item.clientId)
        .map((o) => [`${o.item.clientId}|${o.item.reasonCode}`, o.item]),
    );
    if (admin)
      for (const item of pairs.values()) {
        const [groupCode, carc] = item.reasonCode.split('-') as [string, string];
        const code = await postedCodeFor(tenantId, item.clientId!, groupCode, carc);
        if (!code) continue;
        const res = await withTenant(deps.db, { tenantId, userId: admin }, (tx) =>
          saveMapping(
            tx,
            { tenantId, userId: admin },
            {
              clientId: item.clientId!,
              groupCode: groupCode as 'CO',
              carc,
              pmAdjustmentCode: code,
              action: groupCode === 'PR' ? 'transfer_to_patient' : code === 'WO' ? 'write_off' : 'adjust',
              scope: 'pm_type',
            },
          ),
        );
        if (res.ok) done.mapped++;
      }
    return done;
  }

  async function writeOffCode(tenantId: string, clientId: string | null): Promise<string> {
    const rows = await withTenant(deps.db, { tenantId }, (tx) =>
      tx
        .select({ code: adjustmentMappings.pmAdjustmentCode, clientId: adjustmentMappings.clientId })
        .from(adjustmentMappings)
        .where(eq(adjustmentMappings.action, 'write_off')),
    );
    return (rows.find((r) => r.clientId === clientId) ?? rows[0])?.code ?? 'WO';
  }

  /** The PM code most often posted with the same amount as this group and CARC on the same payment. */
  async function postedCodeFor(tenantId: string, clientId: string, group: string, carc: string) {
    const res = await withTenant(deps.db, { tenantId }, (tx) =>
      tx.execute<{ code: string }>(sql`
        select pa->>'pmAdjustmentCode' as code, count(*) as n
        from remit_adjustments ra
        join remit_claims rc on rc.id = ra.remit_claim_id
        join remittances r on r.id = rc.remittance_id
        join pm_postings p on p.client_id = ra.client_id and p.trace_number = r.trace_number
        cross join lateral jsonb_array_elements(p.adjustments) pa
        where ra.client_id = ${clientId} and ra.group_code = ${group} and ra.carc = ${carc}
          and (pa->>'amountCents')::bigint = ra.amount_cents
        group by 1 order by 2 desc limit 1`),
    );
    return res.rows[0]?.code ?? null;
  }

  /** Tebra: a biller downloads the new 835s from the PM and uploads them (R-02). */
  async function uploadEras(c: MockConnection, staff: Staff, day: string) {
    const after = lastEra.get(c.practiceId);
    const { eras } = (await pm(
      `/admin/api/practices/${c.practiceId}/eras${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    )) as { eras: { id: string; receivedAt: string; raw835: string }[] };
    const biller = billerFor(staff, c.clientId, `era:${c.practiceId}:${day}`);
    if (!biller) return 0;
    let n = 0;
    for (const e of eras) {
      const r = parse835(e.raw835);
      await withTenant(deps.db, { tenantId: c.tenantId, userId: biller }, async (tx) => {
        const out = await ingestInTx(
          tx,
          { tenantId: c.tenantId, clientId: c.clientId, source: 'file', actor: `user:${biller}` },
          r,
          clockNow(),
        );
        if (out.status !== 'duplicate') {
          n++;
          await verifyInTx(tx, { tenantId: c.tenantId, clientId: c.clientId }, clockNow());
        }
      });
      lastEra.set(c.practiceId, e.receivedAt);
    }
    return n;
  }

  async function step(conns: MockConnection[], days: number) {
    // The practices' days: visits entered each weekday, then the clock moves on.
    for (let i = 0; i < days; i++) {
      const today = clockNow();
      if (isWeekday(today))
        for (const c of conns) {
          const count =
            4 +
            (createHash('sha256')
              .update(`${c.practiceId}:${ymd(today)}`)
              .digest()[0]! %
              6);
          await pm(`/admin/api/practices/${c.practiceId}/visits`, {
            method: 'POST',
            body: JSON.stringify({ count, dateOfService: ymd(today), openShare: 0 }),
          });
        }
      await advance(-getOffset() < 1.5 * DAY ? Math.floor(-getOffset() / 60_000) : 1440);
    }
    const day = ymd(clockNow());
    await syncAll(conns);
    const tenants = [...new Set(conns.map((c) => c.tenantId))];
    const staff = new Map<string, Staff>();
    for (const t of tenants) staff.set(t, await staffOf(t));
    const worked = [];
    for (const t of tenants) worked.push(await workTheQueue(t, staff.get(t)!, day));
    await quiet();
    await pm('/admin/api/clearinghouse/run?bill=1', { method: 'POST' });
    let uploaded = 0;
    for (const c of conns.filter((x) => x.uploadsEras))
      uploaded += await uploadEras(c, staff.get(c.tenantId)!, day);
    await syncAll(conns);
    await deps.sweep();
    await quiet();
    return { worked, uploaded };
  }

  /** Runs a pending (or abandoned) replay to today. False when there was nothing to run. */
  async function run(): Promise<boolean> {
    const claimed = await claimDemoHistory(deps.db);
    if (!claimed) return false;
    const total = claimed.days ?? 90;
    deps.log.info({ days: total, daysLeft: Math.round(-getOffset() / DAY) }, 'demo history replay started');
    try {
      const conns = await mockConnections();
      if (!conns.length) throw new Error('no mock-PM connections to replay');
      while (-getOffset() > 60_000) {
        const left = -getOffset() / DAY;
        const days = left > 15 ? 3 : 1;
        const out = await step(conns, days);
        const day = Math.max(0, Math.round(total - -getOffset() / DAY));
        await reportDemoHistory(deps.db, { day, beatAt: new Date().toISOString() });
        deps.log.info({ day, of: total, ...out }, 'demo history step');
      }
      await reportDemoHistory(deps.db, { state: 'done', day: total, finishedAt: new Date().toISOString() });
      deps.log.info('demo history replay finished');
    } catch (err) {
      deps.log.error({ err }, 'demo history replay failed');
      await reportDemoHistory(deps.db, {
        state: 'failed',
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
        finishedAt: new Date().toISOString(),
      });
    }
    return true;
  }

  return { run };
}
