/**
 * Payment runs (docs/12-testing.md "Payer simulator"): claims whose adjudication date has come on
 * the simulated clock are decided, then batched into one 835 per submitter, payer and payee.
 * Prompt-pay interest goes on the PLB; a replacement claim (frequency 7) carries the reversal of
 * the payment it replaces (status 22) in the same 835, and a void (8) carries only the reversal.
 * Runs under an advisory lock, so two readers never pay the same claim twice.
 */
import { and, asc, eq, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { remit } from '@cleanpost/domain';
import { write835 } from '@cleanpost/x12';
import type { SubmittedClaim } from './ack';
import { adjudicate, type NcciPair } from './adjudicate';
import type { SimDb } from './db';
import { payerProfile, type PayerProfile } from './payers';
import { members, remittances, submissions } from './schema';

export interface PaymentRun {
  claims: number;
  remittances: number;
}

type Tx = Parameters<Parameters<SimDb['transaction']>[0]>[0];
type Submission = typeof submissions.$inferSelect;

const RECEIVER_ID = 'CLEARINGHOUSE';
const LOCK = 4031;
const MAX_PER_RUN = 2000;

/** The services a claim bills, for the payer's exact-duplicate edit. */
const serviceKey = (memberId: string | null, c: SubmittedClaim) =>
  `${memberId ?? ''}|${c.dateOfService}|${c.lines
    .map((l) => [l.code, ...[...l.modifiers].sort()].join(':'))
    .sort()
    .join(',')}`;

/** The same services for the same member and day were paid under another claim already. */
async function paidBefore(tx: Tx, s: Submission, claim: SubmittedClaim, key: string) {
  if (!s.memberId) return false;
  const others = await tx
    .select({ id: submissions.id, claim: submissions.claim, adjudication: submissions.adjudication })
    .from(submissions)
    .where(
      and(
        eq(submissions.source, s.source),
        eq(submissions.memberId, s.memberId),
        eq(submissions.dateOfService, claim.dateOfService),
        ne(submissions.id, s.id),
        isNotNull(submissions.adjudication),
      ),
    );
  return others.some(
    (o) =>
      o.id !== s.replaces &&
      (o.adjudication as remit.ClaimPayment).statusCode !== '4' &&
      serviceKey(s.memberId, o.claim as SubmittedClaim) === key,
  );
}

/** The reversal of an earlier payment: every amount negated, the payer's claim number kept. */
export function reversalOf(p: remit.ClaimPayment): remit.ClaimPayment {
  const neg = (a: remit.Adjustment) => ({ ...a, amountCents: -a.amountCents });
  return {
    ...p,
    statusCode: '22',
    chargeCents: -p.chargeCents,
    paidCents: -p.paidCents,
    patientRespCents: -p.patientRespCents,
    adjustments: p.adjustments.map(neg),
    lines: p.lines.map((l) => ({
      ...l,
      chargeCents: -l.chargeCents,
      paidCents: -l.paidCents,
      allowedCents: l.allowedCents === null ? null : -l.allowedCents,
      adjustments: l.adjustments.map(neg),
    })),
  };
}

interface Batch {
  source: string;
  payer: PayerProfile;
  payee: { name: string; npi: string | null };
  claims: remit.ClaimPayment[];
  plb: remit.ProviderAdjustment[];
  decided: { id: string; payment: remit.ClaimPayment | null }[];
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function runPayments(db: SimDb, now: Date, ncci: readonly NcciPair[]): Promise<PaymentRun> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
    const due = await tx
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.ackStatus, 'accepted'),
          isNotNull(submissions.adjudicateAt),
          lte(submissions.adjudicateAt, now),
          isNull(submissions.remittanceId),
        ),
      )
      .orderBy(asc(submissions.adjudicateAt), asc(submissions.id))
      .limit(MAX_PER_RUN);
    if (!due.length) return { claims: 0, remittances: 0 };

    const batches = new Map<string, Batch>();
    const paidThisRun = new Set<string>();
    for (const s of due) {
      const claim = s.claim as SubmittedClaim;
      const payer = payerProfile(s.payerId, s.payerName);
      const batchKey = `${s.source}|${payer.id}|${claim.billingNpi ?? ''}`;
      let b = batches.get(batchKey);
      if (!b) {
        b = {
          source: s.source,
          payer,
          payee: { name: claim.billingName ?? 'PROVIDER', npi: claim.billingNpi },
          claims: [],
          plb: [],
          decided: [],
        };
        batches.set(batchKey, b);
      }
      if (s.replaces) {
        const [prior] = await tx.select().from(submissions).where(eq(submissions.id, s.replaces));
        if (prior?.adjudication) b.claims.push(reversalOf(prior.adjudication as remit.ClaimPayment));
      }
      if (claim.frequencyCode === '8') {
        b.decided.push({ id: s.id, payment: null });
        continue;
      }
      const [member] = s.memberId
        ? await tx
            .select()
            .from(members)
            .where(and(eq(members.payerId, payer.id), eq(members.memberId, s.memberId)))
        : [];
      const key = serviceKey(s.memberId, claim);
      const duplicate = paidThisRun.has(key) || (await paidBefore(tx, s, claim, key));
      const { payment, deductibleUsedCents } = adjudicate({
        claim,
        payer,
        member: member ?? null,
        receivedAt: s.receivedAt,
        duplicate,
        ncci,
      });
      if (member && deductibleUsedCents) {
        await tx
          .update(members)
          .set({
            deductibleRemainingCents: sql`greatest(0, coalesce(${members.deductibleRemainingCents}, 0) - ${deductibleUsedCents})`,
          })
          .where(and(eq(members.payerId, member.payerId), eq(members.memberId, member.memberId)));
      }
      if (payment.statusCode !== '4') paidThisRun.add(key);
      b.claims.push(payment);
      b.decided.push({ id: s.id, payment });
      const waited = Math.floor((now.getTime() - s.receivedAt.getTime()) / 86_400_000);
      if (payer.interestAfterDays !== null && waited >= payer.interestAfterDays && payment.paidCents > 0) {
        // 12% a year on the late payment; negative on the PLB because it adds to the check.
        const interest = Math.round((payment.paidCents * 0.12 * waited) / 365);
        if (interest > 0) {
          b.plb.push({
            reasonCode: 'L6',
            reference: payment.payerClaimControlNumber,
            amountCents: -interest,
          });
        }
      }
    }

    const [{ last } = { last: 0 }] = await tx
      .select({ last: sql<number>`coalesce(max(${remittances.control}), 0)::int` })
      .from(remittances);
    let control = last;
    let made = 0;
    for (const b of batches.values()) {
      control++;
      const paid = b.claims.reduce((s, c) => s + c.paidCents, 0);
      const plb = b.plb.reduce((s, p) => s + p.amountCents, 0);
      const amountCents = paid - plb;
      const method = amountCents === 0 ? 'NON' : b.payer.method;
      const traceNumber =
        method === 'CHK'
          ? String(1_000_000 + control)
          : `${isoDay(now).replaceAll('-', '')}${String(control).padStart(6, '0')}`;
      const r: remit.Remittance835 = {
        payment: { method, amountCents, paymentDate: isoDay(now), traceNumber },
        payer: { name: b.payer.name.toUpperCase(), id: b.payer.id },
        payee: { name: b.payee.name.toUpperCase(), npi: b.payee.npi },
        claims: b.claims,
        providerAdjustments: b.plb,
      };
      const id = `${b.payer.id}-${String(control).padStart(9, '0')}`;
      await tx.insert(remittances).values({
        id,
        control,
        source: b.source,
        payerId: b.payer.id,
        payerName: b.payer.name,
        traceNumber,
        method,
        amountCents,
        paymentDate: isoDay(now),
        claimCount: b.claims.length,
        x12: write835(r, { senderId: b.payer.id, receiverId: RECEIVER_ID, control, at: now }),
        createdAt: now,
      });
      for (const d of b.decided) {
        await tx
          .update(submissions)
          .set({ adjudication: d.payment, remittanceId: id })
          .where(eq(submissions.id, d.id));
      }
      made++;
    }
    return { claims: due.length, remittances: made };
  });
}
