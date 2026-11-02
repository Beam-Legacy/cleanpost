/**
 * The mock PM's clearinghouse (Mode A, docs/12-testing.md): claims the PM queued (an approved
 * Tebra encounter, a released charge) go to payer-sim; the 277CA results come back onto the PM's
 * claims, where Cleanpost reads them through `pullClaimsAndStatus`.
 *
 * The payer's view of each member comes from the generator's answer key: coverage marked inactive is
 * inactive at the payer, and coverage that really belongs to another payer is "not found".
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Logger } from '@cleanpost/log';
import { SIM_PAYER_IDS } from '@cleanpost/seed/world';
import { parse835 } from '@cleanpost/x12';
import type { PmDb } from './db';
import { receiveEra } from './era';
import { PROFILE_RULES } from './profiles';
import {
  accounts,
  answerKey,
  charges,
  claims,
  clearinghouseState,
  encounters,
  policies,
  practices,
} from './schema';

export interface ClearinghouseDeps {
  db: PmDb;
  log: Logger;
  payerSimUrl: string;
  token?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ClearinghouseRun {
  /** Encounters the PM billed on its own (profiles with no hold, at the batch). */
  billed: number;
  sent: number;
  accepted: number;
  rejected: number;
  remits: number;
  linesPosted: number;
}

const BATCH = 200;

/**
 * The PM's own billing batch, for profiles with no hold (managed_api): every ready encounter is
 * billed and queued for the clearinghouse, whatever Cleanpost thinks of it. That is why Cleanpost
 * reviews these clients before their batch time (docs/04-modes.md, Mode A without hold).
 */
export async function billReady(db: PmDb, practiceId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ profile: accounts.profile })
    .from(practices)
    .innerJoin(accounts, eq(accounts.id, practices.accountId))
    .where(eq(practices.id, practiceId));
  if (!row || PROFILE_RULES[row.profile].hold !== false) return 0;
  const ready = await db
    .select({ id: encounters.id })
    .from(encounters)
    .where(
      and(
        eq(encounters.practiceId, practiceId),
        eq(encounters.status, 'ready'),
        eq(encounters.onHold, false),
      ),
    );
  for (const e of ready) {
    await db.transaction(async (tx) => {
      await tx
        .update(encounters)
        .set({ status: 'billed', patientControlNumber: e.id, updatedAt: now })
        .where(eq(encounters.id, e.id));
      await tx
        .insert(claims)
        .values({
          encounterId: e.id,
          practiceId,
          patientControlNumber: e.id,
          status: 'queued',
          updatedAt: now,
        })
        .onConflictDoNothing();
    });
  }
  return ready.length;
}

interface Remit {
  id: string;
  control: number;
  x12: string;
}

interface Ack {
  patientControlNumber: string;
  status: 'accepted' | 'rejected';
  codes: string[];
  reasons: string[];
  at: string;
}

async function memberStatus(db: PmDb, practiceId: string, policyId: string | undefined) {
  if (!policyId) return 'not_found' as const;
  const [fact] = await db
    .select({ facts: answerKey.facts })
    .from(answerKey)
    .where(
      and(
        eq(answerKey.practiceId, practiceId),
        eq(answerKey.recordType, 'coverage'),
        eq(answerKey.recordId, policyId),
      ),
    );
  const f = (fact?.facts ?? {}) as { inactive?: boolean; actualPayerName?: string };
  if (f.actualPayerName) return 'not_found' as const;
  return f.inactive ? ('inactive' as const) : ('active' as const);
}

/** Claims the PM has queued, as the payer receives them (codes and amounts, no names). */
async function queued(db: PmDb, practiceId: string, practiceName: string) {
  const rows = await db
    .select({ claim: claims, encounter: encounters })
    .from(claims)
    .innerJoin(encounters, eq(encounters.id, claims.encounterId))
    .where(and(eq(claims.practiceId, practiceId), eq(claims.status, 'queued')))
    .orderBy(asc(claims.updatedAt))
    .limit(BATCH);
  const out = [];
  for (const { claim, encounter: e } of rows) {
    const lines = await db
      .select()
      .from(charges)
      .where(eq(charges.encounterId, e.id))
      .orderBy(asc(charges.lineNumber));
    const [policy] = await db
      .select()
      .from(policies)
      .where(and(eq(policies.patientId, e.patientId), eq(policies.priority, 1)))
      .limit(1);
    const diagnoses = ((e.diagnoses ?? []) as { sequence: number; icd10: string }[])
      .slice()
      .sort((a, b) => a.sequence - b.sequence);
    out.push({
      patientControlNumber: claim.patientControlNumber,
      payerName: policy?.payerName ?? 'Unknown payer',
      payerId: policy ? (SIM_PAYER_IDS[policy.payerName] ?? null) : null,
      memberId: policy?.memberId ?? null,
      priorAuthNumber: e.priorAuthNumber,
      frequencyCode: claim.frequencyCode as '1' | '7' | '8',
      billingName: practiceName,
      dateOfService: e.dateOfService,
      renderingNpi: e.renderingNpi,
      // The mock PM has no group NPI; the rendering provider bills.
      billingNpi: e.renderingNpi,
      member: { status: await memberStatus(db, practiceId, policy?.id) },
      diagnoses,
      lines: lines.map((l) => ({
        lineNumber: l.lineNumber,
        // The PM's own line ID goes out as the line control number (REF*6R) and comes back on the 835.
        lineControlNumber: l.id,
        code: l.code,
        modifiers: l.modifiers,
        units: l.units,
        chargeCents: l.chargeCents,
        pointers: l.pointers,
      })),
      totalChargeCents: lines.reduce((s, l) => s + l.chargeCents, 0),
    });
  }
  return out;
}

export async function runClearinghouse(
  deps: ClearinghouseDeps,
  opts: { bill?: boolean } = {},
): Promise<ClearinghouseRun> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const headers = {
    'content-type': 'application/json',
    ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
  };
  const run: ClearinghouseRun = { billed: 0, sent: 0, accepted: 0, rejected: 0, remits: 0, linesPosted: 0 };
  const all = await deps.db.select({ id: practices.id, name: practices.name }).from(practices);
  for (const { id: practiceId, name } of all) {
    const source = `pm-mock:${practiceId}`;
    // 0. The PM's own billing batch, when it is due.
    if (opts.bill) run.billed += await billReady(deps.db, practiceId, now());
    // 1. Send the queued batch.
    const batch = await queued(deps.db, practiceId, name);
    if (batch.length) {
      const res = await doFetch(`${deps.payerSimUrl}/claims`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source, claims: batch }),
      });
      if (!res.ok) throw new Error(`payer-sim refused the batch: ${res.status}`);
      await deps.db
        .update(claims)
        .set({ status: 'sent', updatedAt: now() })
        .where(
          and(
            eq(claims.practiceId, practiceId),
            inArray(
              claims.patientControlNumber,
              batch.map((c) => c.patientControlNumber),
            ),
            eq(claims.status, 'queued'),
          ),
        );
      run.sent += batch.length;
    }
    // 2. Read the 277CAs that have come back since last time.
    const [state] = await deps.db
      .select()
      .from(clearinghouseState)
      .where(eq(clearinghouseState.practiceId, practiceId));
    const since = state?.acksSince ? `&since=${encodeURIComponent(state.acksSince.toISOString())}` : '';
    const res = await doFetch(`${deps.payerSimUrl}/acks?source=${encodeURIComponent(source)}${since}`, {
      headers,
    });
    if (!res.ok) throw new Error(`payer-sim acks failed: ${res.status}`);
    const { acks } = (await res.json()) as { acks: Ack[] };
    for (const a of acks) {
      const updated = await deps.db
        .update(claims)
        .set({
          status: a.status,
          rejectionReasons: a.status === 'rejected' ? a.reasons : [],
          updatedAt: now(),
        })
        .where(
          and(
            eq(claims.practiceId, practiceId),
            eq(claims.patientControlNumber, a.patientControlNumber),
            inArray(claims.status, ['sent', 'queued']),
          ),
        )
        .returning({ id: claims.encounterId });
      if (updated.length) run[a.status]++;
    }
    const last = acks.at(-1);
    if (last) {
      await deps.db
        .insert(clearinghouseState)
        .values({ practiceId, acksSince: new Date(last.at) })
        .onConflictDoUpdate({
          target: clearinghouseState.practiceId,
          set: { acksSince: new Date(last.at) },
        });
    }
    // 3. Bring in the 835s and auto-post them.
    let after = state?.remitsAfter ?? 0;
    for (;;) {
      const rr = await doFetch(
        `${deps.payerSimUrl}/remits?source=${encodeURIComponent(source)}&after=${after}`,
        { headers },
      );
      if (!rr.ok) throw new Error(`payer-sim remits failed: ${rr.status}`);
      const { remits } = (await rr.json()) as { remits: Remit[] };
      for (const m of remits) {
        const posted = await receiveEra(deps.db, {
          practiceId,
          remitId: m.id,
          r: parse835(m.x12),
          raw835: m.x12,
          now: now(),
        });
        if (posted) {
          run.remits++;
          run.linesPosted += posted.posted;
        }
        after = m.control;
      }
      if (remits.length) {
        await deps.db
          .insert(clearinghouseState)
          .values({ practiceId, remitsAfter: after })
          .onConflictDoUpdate({ target: clearinghouseState.practiceId, set: { remitsAfter: after } });
      }
      if (remits.length < 100) break;
    }
  }
  if (run.billed || run.sent || run.accepted || run.rejected || run.remits)
    deps.log.info(run, 'clearinghouse run');
  return run;
}
