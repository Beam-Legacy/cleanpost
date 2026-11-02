/**
 * The payers' member files for payer-sim, from the PM's policies and the generator's answer key:
 * coverage marked inactive is inactive at the payer; coverage that really belongs to another payer
 * is enrolled there instead (so the claimed payer does not find the member). Synthetic data only.
 */
import { and, eq } from 'drizzle-orm';
import { SIM_PAYER_IDS } from '@cleanpost/seed/world';
import type { PmDb } from './db';
import { answerKey, patients, policies } from './schema';

export interface RosterMember {
  payerId: string;
  memberId: string;
  dateOfBirth: string;
  status: 'active' | 'inactive';
  planBegin: string | null;
  planEnd: string | null;
  copayCents: number;
  deductibleRemainingCents: number;
  coinsurancePercent: number;
}

const ymd = (d: string | null) => (d ? d.replaceAll('-', '') : null);

/** Stable cost sharing per member, so checks repeat exactly. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export async function memberRoster(db: PmDb): Promise<RosterMember[]> {
  const rows = await db
    .select({ policy: policies, dob: patients.dob })
    .from(policies)
    .innerJoin(patients, eq(patients.id, policies.patientId));
  const out: RosterMember[] = [];
  for (const { policy: p, dob } of rows) {
    const [fact] = await db
      .select({ facts: answerKey.facts })
      .from(answerKey)
      .where(
        and(
          eq(answerKey.practiceId, p.practiceId),
          eq(answerKey.recordType, 'coverage'),
          eq(answerKey.recordId, p.id),
        ),
      );
    const f = (fact?.facts ?? {}) as { inactive?: boolean; actualPayerName?: string };
    const payerId = SIM_PAYER_IDS[f.actualPayerName ?? p.payerName];
    if (!payerId) continue;
    const h = hash(p.memberId);
    out.push({
      payerId,
      memberId: p.memberId,
      dateOfBirth: ymd(dob)!,
      status: f.inactive ? 'inactive' : 'active',
      planBegin: ymd(p.effectiveDate),
      planEnd: ymd(p.terminationDate),
      copayCents: 1500 + (h % 4) * 1000,
      deductibleRemainingCents: (h % 7) * 25_000,
      coinsurancePercent: [10, 20, 30][h % 3]!,
    });
  }
  return out;
}

/** Sends the member files to payer-sim in batches. */
export async function loadRoster(
  db: PmDb,
  opts: { payerSimUrl: string; token?: string; fetch?: typeof fetch },
): Promise<number> {
  const doFetch = opts.fetch ?? fetch;
  const roster = await memberRoster(db);
  for (let i = 0; i < roster.length; i += 1000) {
    const res = await doFetch(`${opts.payerSimUrl}/members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ members: roster.slice(i, i + 1000) }),
    });
    if (!res.ok) throw new Error(`payer-sim refused the member file: ${res.status}`);
  }
  return roster.length;
}
