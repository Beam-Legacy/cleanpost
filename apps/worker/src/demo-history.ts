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
 * needs), deterministic by item and day. They work the queue the way a team that keeps up does:
 * approve reviews, apply the scrub's suggested fixes and make the same change in the PM, void
 * duplicates, build corrected claims for denials with a mechanical fix and resubmit them from the
 * PM (Flow 5), write off small denials and, after a while, the ones nothing can fix (an admin
 * above the billers' limit), let coverage the payer rejects go to the patient, settle posting
 * differences, map new adjustment codes and upload Tebra 835s. What is left open is mostly the
 * last few days' work, as it would be. Local and preview only; IDs only in the logs.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  approveClaim,
  buildCorrection,
  CORRECTION_OPERATION,
  editClaim,
  RESUBMIT_OPERATION,
  voidClaim,
  WRITE_OFF_OPERATION,
  writeOffClaim,
} from '@cleanpost/claims';
import { getOffset, now as clockNow } from '@cleanpost/clock';
import {
  adjustmentMappings,
  claimDemoHistory,
  claims,
  claimVersions,
  connections,
  externalRefs,
  memberships,
  reportDemoHistory,
  setDemoOffset,
  users,
  withTenant,
  workItems,
  type Database,
} from '@cleanpost/db';
import { remit, type ClaimPayload } from '@cleanpost/domain';
import { JOBS, sendClaimCorrect, sendClaimRelease, sendClaimScrub, sendSyncPull } from '@cleanpost/jobs';
import type { Logger } from '@cleanpost/log';
import { ingestInTx, saveMapping, verifyInTx } from '@cleanpost/remit';
import { listCandidates } from '@cleanpost/sync';
import { resolveItem } from '@cleanpost/work';
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
  const connectionsById = new Map<string, MockConnection>();

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
            inArray(workItems.type, [
              'claim_review',
              'claim_blocked',
              'eligibility_issue',
              'rejection',
              'denial',
              'mapping_needed',
              'posting_exception',
              'manual_task',
            ]),
          ),
        ),
    );
    const keepForDemo = open
      .filter((o) => o.item.type === 'denial' && o.item.reasonCode === '4')
      .sort((a, b) => b.item.createdAt.getTime() - a.item.createdAt.getTime())[0]?.item.id;
    const done = {
      approved: 0,
      fixed: 0,
      corrected: 0,
      inPm: 0,
      voided: 0,
      writtenOff: 0,
      mapped: 0,
      resolved: 0,
    };
    for (const { item, claimStatus, balance } of open) {
      const key = `${item.id}:${day}`;
      const biller = billerFor(staff, item.clientId, key);
      if (!biller) continue;
      const age = now.getTime() - item.createdAt.getTime();
      try {
        // Hand work done in the PM (posting a write-off there), and posting differences checked.
        if (item.type === 'manual_task' && item.reasonCode === WRITE_OFF_OPERATION && chance(key, 0.7)) {
          const res = await resolveItem(deps.db, { tenantId, userId: biller, now }, item.id, {
            reason: 'Done in the PM',
          });
          if (res.ok) done.resolved++;
          continue;
        }
        // A charge correction the PM takes only by hand: the biller makes it in the PM; the next
        // sync sees it, closes the task and lets the claim go.
        if (item.type === 'manual_task' && item.reasonCode === CORRECTION_OPERATION && item.claimId) {
          if (chance(key, 0.85) && (await changeInPm(tenantId, item.claimId, 'charges'))) done.inPm++;
          continue;
        }
        // A corrected claim (Flow 5): resubmitted from the PM with the payer's claim number.
        if (item.type === 'manual_task' && item.reasonCode === RESUBMIT_OPERATION && item.claimId) {
          if (chance(key, 0.85) && (await changeInPm(tenantId, item.claimId, 'resubmit'))) {
            const res = await resolveItem(deps.db, { tenantId, userId: biller, now }, item.id, {
              reason: 'Done in the PM',
            });
            if (res.ok) done.inPm++;
          }
          continue;
        }
        if (item.type === 'posting_exception' && age > 4 * DAY && chance(key, 0.5)) {
          const reason = chance(`${item.id}:reason`, 0.5) ? 'Corrected in the PM' : 'Accepted as posted';
          const res = await resolveItem(deps.db, { tenantId, userId: biller, now }, item.id, { reason });
          if (res.ok) done.resolved++;
          continue;
        }
        if (!item.claimId) continue;
        await claimWork(item, claimStatus, balance, biller, key, age);
      } catch (err) {
        // One item a simulated biller cannot work is left for the backlog; the replay goes on.
        deps.log.warn({ err, workItemId: item.id }, 'demo biller skipped an item');
      }
    }

    async function claimWork(
      item: (typeof open)[number]['item'],
      claimStatus: string | null,
      balance: number | string | bigint | null,
      biller: string,
      key: string,
      age: number,
    ) {
      if (!item.claimId) return;
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
        !item.reasonCode.startsWith('eligibility.') &&
        item.reasonCode !== 'history.duplicate' &&
        chance(key, 0.85)
      ) {
        // The scrub's suggested fix, as W-10's "Approve and release (fixes first)" applies it; in
        // Mode A the change goes to the PM (by hand where the PM has no corrections API).
        const res = await editClaim(
          deps.db,
          { tenantId, userId: biller, claimId: item.claimId, workItemId: item.id },
          { kind: 'fix', ruleIds: [item.reasonCode] },
        );
        if (res.status === 'edited') {
          if (res.writeBack)
            await sendClaimCorrect(deps.boss, { tenantId, claimId: item.claimId, versionId: res.versionId });
          await sendClaimScrub(deps.boss, { tenantId, claimVersionId: res.versionId });
          done.fixed++;
        }
      } else if (
        (item.type === 'eligibility_issue' ||
          (item.type === 'claim_blocked' && item.reasonCode.startsWith('eligibility.'))) &&
        age > 4 * DAY &&
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
      } else if (item.type === 'rejection' && /subscriber|member|coverage/i.test(item.summary)) {
        // The payer does not know the member: no other coverage turned up, so the claim is voided
        // in the PM and the patient pays.
        if (age > 4 * DAY && chance(key, 0.4)) {
          const res = await resolveItem(deps.db, { tenantId, userId: biller, now }, item.id, {
            reason: 'Voided',
          });
          if (res.ok) done.resolved++;
        }
      } else if (item.type === 'rejection' && /pointer/i.test(item.summary) && chance(key, 0.7)) {
        // W-12: the pointer corrected in the PM and the claim sent again from there as a new claim
        // (frequency 1). Other front-end rejections (an NPI, the totals) wait for a person.
        if (await changeInPm(tenantId, item.claimId, 'resend')) done.inPm++;
      } else if (item.type === 'denial' && item.id === keepForDemo) {
        // The newest CO-4 waits for the demo's Flow 5 (docs/18).
        return;
      } else if (item.type === 'denial' && age > 5 * DAY && chance(key, 0.4)) {
        // A denial with a mechanical fix (modifier 25 for CO-4, say): the corrected claim, built as
        // W-16 builds it, then scrubbed; approval, release and the resubmission follow.
        const fix = await denialFix(tenantId, item.claimId, item.reasonCode);
        if (fix) {
          const built = await buildCorrection(
            deps.db,
            { tenantId, userId: biller, claimId: item.claimId, workItemId: item.id },
            { fix },
          );
          if (built.status === 'built') {
            await sendClaimScrub(deps.boss, { tenantId, claimVersionId: built.versionId });
            done.corrected++;
          }
        } else if (age > 10 * DAY) {
          // Nothing to correct and nobody will pay it: written off, by an admin above the limit.
          const amountCents = writeOffDefaultCents(item.amountCents ?? 0, Number(balance ?? 0));
          if (amountCents <= 0) return;
          const admin = pick(`${key}:admin`, staff.admins);
          const overLimit = amountCents > 50_000;
          const actor = overLimit ? admin : biller;
          if (!actor) return;
          const eligibility = item.reasonCode === '27' || item.reasonCode === '31';
          const res = await writeOffClaim(
            deps.db,
            { tenantId, userId: actor, claimId: item.claimId, overLimit: overLimit ? 'allowed' : 'refused' },
            {
              amountCents,
              reason: eligibility ? 'Patient not covered and not billable' : 'Not worth pursuing',
              note: eligibility ? 'No other coverage found.' : 'Payer will not reconsider.',
              pmCode: await writeOffCode(tenantId, item.clientId),
              denialItemId: item.id,
            },
          );
          if (res.status === 'written_off') done.writtenOff++;
        }
      } else if (
        item.type === 'denial' &&
        (item.amountCents ?? 0) > 0 &&
        (item.amountCents ?? 0) <= 15_000 &&
        age > 3 * DAY &&
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

  /** The claim's current version and the PM's encounter it came from. */
  async function claimInPm(tenantId: string, claimId: string) {
    return withTenant(deps.db, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ claim: claims, payload: claimVersions.payload, originalRef: claimVersions.originalRef })
        .from(claims)
        .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
        .where(eq(claims.id, claimId));
      if (!row) return null;
      const [ref] = await tx
        .select({ externalId: externalRefs.externalId, connectionId: externalRefs.connectionId })
        .from(externalRefs)
        .where(
          and(eq(externalRefs.entityType, 'encounter'), eq(externalRefs.entityId, row.claim.encounterId)),
        );
      return ref ? { payload: row.payload as ClaimPayload, originalRef: row.originalRef, ref } : null;
    });
  }

  /**
   * What a correction or resubmission task asks, done by hand in the PM: the lines' modifiers and
   * pointers as the claim's current version has them, and for a corrected claim, sent again with
   * frequency 7 and the payer's claim number.
   */
  async function changeInPm(tenantId: string, claimId: string, kind: 'charges' | 'resubmit' | 'resend') {
    const found = await claimInPm(tenantId, claimId);
    const conn = found && connectionsById.get(found.ref.connectionId);
    if (!found || !conn) return false;
    const path = `/admin/api/practices/${conn.practiceId}/encounters/${encodeURIComponent(found.ref.externalId)}`;
    const lines = found.payload.lines;
    if (kind === 'resend') {
      // A pointer past the claim's diagnoses points at the first one.
      const dx = found.payload.diagnoses.length;
      await pm(`${path}/resubmit`, {
        method: 'POST',
        body: JSON.stringify({
          frequencyCode: '1',
          changes: lines.map((l) => {
            const ok = l.dxPointers.filter((p) => p <= dx);
            return { lineNumber: l.lineNumber, diagnosisPointers: ok.length ? ok : [1] };
          }),
        }),
      });
    } else if (kind === 'resubmit')
      await pm(`${path}/resubmit`, {
        method: 'POST',
        body: JSON.stringify({
          changes: lines.map((l) => ({ lineNumber: l.lineNumber, modifiers: l.modifiers })),
          ...(found.originalRef ? { originalRef: found.originalRef } : {}),
        }),
      });
    else
      await pm(`${path}/charges`, {
        method: 'POST',
        body: JSON.stringify({
          changes: lines.map((l) => ({
            lineNumber: l.lineNumber,
            modifiers: l.modifiers,
            ...(l.dxPointers.length ? { diagnosisPointers: l.dxPointers } : {}),
          })),
        }),
      });
    return true;
  }

  /** The denial's suggested fix where it is mechanical (domain advice, as W-16 shows it). */
  async function denialFix(tenantId: string, claimId: string, carc: string) {
    const found = await claimInPm(tenantId, claimId);
    if (!found) return null;
    for (const l of found.payload.lines) {
      const advice = remit.adviseDenial(
        found.payload,
        {
          lineNumber: l.lineNumber,
          code: l.code,
          modifiers: l.modifiers,
          group: 'CO',
          carc,
          amountCents: 0,
          remarks: [],
        },
        [],
      );
      const s = advice.suggestion;
      if (s && !s.needsInput) return { fix: s.fix, lineNumbers: s.lineNumbers };
    }
    return null;
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
      for (const c of conns) connectionsById.set(c.connectionId, c);
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
