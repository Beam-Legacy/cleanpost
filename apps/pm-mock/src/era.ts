/**
 * ERAs in the mock PM (docs/12-testing.md): the clearinghouse brings each 835 from payer-sim, the
 * PM keeps the file and its own JSON view of it (GET /remittances, where the profile has one), and
 * auto-posts it the way PMs do: one payment per 835, one posting per service line, adjustments in
 * the PM's own codes, patient responsibility transferred, denials left open.
 *
 * Auto-posting is not perfect in real PMs, and Cleanpost's job in Mode A is to catch that. A few
 * lines (stable per line, so runs repeat) are posted wrong on purpose:
 * - skipped: the line is not posted at all;
 * - denial written off: a denied line is closed with a contractual adjustment;
 * - wrong code: the contractual write-off goes in as a small-balance write-off.
 */
import { and, eq } from 'drizzle-orm';
import type { remit } from '@cleanpost/domain';
import type { PmDb } from './db';
import { charges, claims, payments, postings, remittances } from './schema';

/** The PM's adjustment codes for each group and CARC it auto-posts (ADJUSTMENT_CODES in load.ts). */
const PM_CODE: Record<string, string> = {
  'CO-45': 'CONTR',
  'PR-1': 'DEDUCT',
  'PR-2': 'COINS',
  'PR-3': 'COPAY',
};

export type PostingFault = 'skipped' | 'denial_written_off' | 'wrong_code';

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Per line: about 1.5% skipped, 1.5% wrong code, and a third of denied lines written off. */
export function postingFault(key: string, denied: boolean): PostingFault | null {
  const h = hash(`post:${key}`) % 1000;
  if (denied) return h < 330 ? 'denial_written_off' : null;
  if (h < 15) return 'skipped';
  if (h < 30) return 'wrong_code';
  return null;
}

/** The PM's JSON view of an 835: the contract's ExtRemittance without its ID, plus the file. */
export function toEra(r: remit.Remittance835, raw835: string) {
  const adj = (a: remit.Adjustment) => ({
    groupCode: a.group,
    carc: a.carc,
    amountCents: a.amountCents,
    ...(a.quantity !== undefined ? { quantity: a.quantity } : {}),
  });
  return {
    payerName: r.payer.name,
    traceNumber: r.payment.traceNumber,
    paymentMethod: r.payment.method,
    paymentAmountCents: r.payment.amountCents,
    paymentDate: r.payment.paymentDate,
    raw835,
    claims: r.claims.map((c) => ({
      patientControlNumber: c.patientControlNumber,
      payerClaimControlNumber: c.payerClaimControlNumber ?? '',
      statusCode: c.statusCode,
      chargeCents: c.chargeCents,
      paidCents: c.paidCents,
      patientRespCents: c.patientRespCents,
      adjustments: c.adjustments.map(adj),
      lines: c.lines.map((l) => ({
        ...(l.lineControlNumber ? { lineControlNumber: l.lineControlNumber } : {}),
        code: l.code,
        modifiers: l.modifiers,
        units: l.units,
        chargeCents: l.chargeCents,
        ...(l.allowedCents !== null ? { allowedCents: l.allowedCents } : {}),
        paidCents: l.paidCents,
        adjustments: l.adjustments.map(adj),
        remarks: l.remarks,
      })),
    })),
    providerAdjustments: r.providerAdjustments.map((p) => ({
      reasonCode: p.reasonCode,
      reference: p.reference ?? '',
      amountCents: p.amountCents,
    })),
  };
}

const DENIAL_GROUPS = new Set(['CO', 'OA', 'PI']);

/** One line's posting in the PM's terms, or null when the fault skips it. */
export function linePosting(l: remit.ServiceLinePayment, fault: PostingFault | null) {
  if (fault === 'skipped') return null;
  const adjustments: { code: string; amountCents: number }[] = [];
  let patientRespCents = 0;
  for (const a of l.adjustments) {
    const code = PM_CODE[`${a.group}-${a.carc}`];
    if (a.group === 'PR') patientRespCents += a.amountCents;
    if (code) {
      adjustments.push({
        code: code === 'CONTR' && fault === 'wrong_code' ? 'WO' : code,
        amountCents: a.amountCents,
      });
    } else if (DENIAL_GROUPS.has(a.group) && fault === 'denial_written_off') {
      adjustments.push({ code: 'CONTR', amountCents: a.amountCents });
    }
  }
  return { paidCents: l.paidCents, adjustments, patientRespCents };
}

export interface PostResult {
  paymentId: string;
  posted: number;
  skipped: number;
  unmatchedClaims: number;
}

/**
 * Stores the 835 and auto-posts it. Idempotent on the remittance ID: a second delivery of the same
 * 835 changes nothing.
 */
export async function receiveEra(
  db: PmDb,
  input: { practiceId: string; remitId: string; r: remit.Remittance835; raw835: string; now: Date },
): Promise<PostResult | null> {
  const { practiceId, remitId, r, now } = input;
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(remittances)
      .values({ id: remitId, practiceId, payload: toEra(r, input.raw835), receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: remittances.id });
    if (!inserted.length) return null;
    const paymentId = `ERA-${remitId}`;
    await tx.insert(payments).values({
      id: paymentId,
      practiceId,
      payerName: r.payer.name,
      traceNumber: r.payment.traceNumber,
      method: r.payment.method,
      amountCents: r.payment.amountCents,
      paymentDate: r.payment.paymentDate,
      headerOnly: false,
      source: 'clearinghouse',
      createdAt: now,
    });
    const result: PostResult = { paymentId, posted: 0, skipped: 0, unmatchedClaims: 0 };
    for (const c of r.claims) {
      const [claim] = await tx
        .select({ encounterId: claims.encounterId })
        .from(claims)
        .where(
          and(eq(claims.practiceId, practiceId), eq(claims.patientControlNumber, c.patientControlNumber)),
        );
      if (!claim) {
        result.unmatchedClaims++;
        continue;
      }
      const lines = await tx.select().from(charges).where(eq(charges.encounterId, claim.encounterId));
      for (const l of c.lines) {
        const charge =
          lines.find((x) => x.id === l.lineControlNumber) ??
          lines.find((x) => x.code === l.code && x.units === l.units);
        const denied =
          l.paidCents === 0 && l.adjustments.some((a) => DENIAL_GROUPS.has(a.group) && a.carc !== '45');
        const p = linePosting(l, postingFault(`${remitId}:${l.lineControlNumber ?? l.code}`, denied));
        if (!p) {
          result.skipped++;
          continue;
        }
        await tx.insert(postings).values({
          practiceId,
          paymentId,
          encounterId: claim.encounterId,
          chargeId: charge?.id ?? null,
          ...p,
          postedAt: now,
        });
        result.posted++;
      }
      // The PM's claim status follows the payer's decision; a reversal leaves it as it is.
      if (c.statusCode !== '22') {
        await tx
          .update(claims)
          .set({ status: c.statusCode === '4' ? 'denied' : 'paid', updatedAt: now })
          .where(
            and(eq(claims.practiceId, practiceId), eq(claims.patientControlNumber, c.patientControlNumber)),
          );
      }
    }
    return result;
  });
}
