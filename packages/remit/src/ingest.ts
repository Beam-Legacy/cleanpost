/**
 * `remit.ingest` (docs/07-remittance-posting.md): store an 835 once, check that it balances,
 * match its claims and lines, and move each matched claim (paid, partly paid, denied, reversed).
 *
 * - Idempotent on (client, payer, trace number, amount, payment date): a retransmission is recorded
 *   and ignored.
 * - Nothing is matched while the 835 does not balance: the remittance is out_of_balance and one
 *   work item says by how much.
 * - Unmatched claims and denials become work items; amounts in cents throughout.
 * Patient names in the 835 are not stored here (matching by name is the heuristic step, later).
 */
import { and, desc, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { applyClaimEvent, resolveAnsweredDenials, resolveFollowUps } from '@cleanpost/claims';
import {
  claimLines,
  claims,
  payers,
  providerAdjustments,
  recordAudit,
  remitAdjustments,
  remitClaims,
  remitLines,
  remitRemarks,
  remittances,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { formatCents, remit, state } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { createWorkItem } from './items';
import { now as clockNow } from '@cleanpost/clock';

export interface IngestDeps {
  db: Database;
  log: Logger;
  now?: () => Date;
}

export type IngestOutcome =
  | { status: 'duplicate'; remittanceId: string }
  | { status: 'out_of_balance'; remittanceId: string; differenceCents: number }
  | {
      status: 'ingested';
      remittanceId: string;
      matched: number;
      unmatched: number;
      denied: number;
      remittanceStatus: 'matched' | 'partially_matched';
    };

async function move(tx: Tx, id: string, from: state.RemittanceState, event: state.RemittanceEvent) {
  const next = state.nextRemittanceState(from, event);
  if (!next.ok) throw new Error(`remittance ${from} cannot ${event}`);
  await tx
    .update(remittances)
    .set({ status: next.value, updatedAt: clockNow() })
    .where(eq(remittances.id, id));
  return next.value;
}

async function payerOf(tx: Tx, r: remit.Remittance835) {
  const [p] = await tx
    .select({ id: payers.id })
    .from(payers)
    .where(
      or(
        r.payer.id ? eq(payers.stediPayerId, r.payer.id) : sql`false`,
        sql`lower(${payers.name}) = lower(${r.payer.name})`,
        sql`lower(${r.payer.name}) = any(select lower(a) from unnest(${payers.aliases}) a)`,
      ),
    )
    .limit(1);
  return p?.id ?? null;
}

export async function matchClaim(tx: Tx, clientId: string, c: remit.ClaimPayment) {
  const [byPcn] = await tx
    .select()
    .from(claims)
    .where(and(eq(claims.clientId, clientId), eq(claims.patientControlNumber, c.patientControlNumber)));
  if (byPcn) return { claim: byPcn, by: 'pcn' as const };
  if (c.payerClaimControlNumber) {
    const [prior] = await tx
      .select({ claimId: remitClaims.claimId })
      .from(remitClaims)
      .where(
        and(
          eq(remitClaims.clientId, clientId),
          eq(remitClaims.payerClaimControlNumber, c.payerClaimControlNumber),
          isNotNull(remitClaims.claimId),
        ),
      )
      .orderBy(desc(remitClaims.createdAt))
      .limit(1);
    if (prior?.claimId) {
      const [claim] = await tx.select().from(claims).where(eq(claims.id, prior.claimId));
      if (claim) return { claim, by: 'payer_claim_number' as const };
    }
  }
  return null;
}

/** Line matching: the line control number, else code, modifiers, units and charge, in order. */
function matchLines(
  lines: (typeof claimLines.$inferSelect)[],
  paid: remit.ServiceLinePayment[],
): (string | null)[] {
  const used = new Set<string>();
  return paid.map((p) => {
    const exact = p.lineControlNumber
      ? lines.find((l) => l.lineControlNumber === p.lineControlNumber && !used.has(l.id))
      : undefined;
    const found =
      exact ??
      lines.find(
        (l) =>
          !used.has(l.id) &&
          l.code === p.code &&
          l.units === p.units &&
          Math.abs(l.chargeCents) === Math.abs(p.chargeCents) &&
          [...l.modifiers].sort().join(',') === [...p.modifiers].sort().join(','),
      );
    if (!found) return null;
    used.add(found.id);
    return found.id;
  });
}

/** Moves the claim for this payment through the claim machine; returns the event applied. */
async function applyPayment(
  tx: Tx,
  claim: typeof claims.$inferSelect,
  c: remit.ClaimPayment,
  outcome: remit.PaymentOutcome,
  ctx: { remittanceId: string; traceNumber: string; actor: AuditActor; now: Date },
) {
  let current = claim;
  const payload = {
    remittanceId: ctx.remittanceId,
    traceNumber: ctx.traceNumber,
    paidCents: c.paidCents,
    statusCode: c.statusCode,
  };
  // An 835 can arrive before the PM shows the 277CA (Mode A): the payer has clearly accepted it.
  if (current.status === 'submitted' && outcome.event !== 'reverse') {
    const s = await applyClaimEvent(tx, current, 'accept', {
      actor: ctx.actor,
      payload: { source: '835' },
      now: ctx.now,
    });
    current = { ...current, status: s };
  }
  const allowed = state.nextClaimState(current.status as state.ClaimState, outcome.event);
  if (!allowed.ok) return null;
  await applyClaimEvent(tx, current, outcome.event, {
    actor: ctx.actor,
    versionId: current.currentVersionId,
    payload,
    now: ctx.now,
  });
  if (outcome.event !== 'reverse') {
    await tx
      .update(claims)
      .set({ balanceCents: outcome.balanceCents, updatedAt: ctx.now })
      .where(eq(claims.id, claim.id));
    // The payer answered: a follow-up for no acknowledgment or no payment closes itself.
    await resolveFollowUps(tx, current, 'Payment arrived', ctx.actor, ctx.now);
  }
  return outcome.event;
}

/**
 * A payment matched to a claim (by ingestion, or by a person linking it, W-17): link the 835 claim
 * and its lines, move the claim, and open one denial item when anything was denied.
 */
export async function applyMatch(
  tx: Tx,
  v: {
    tenantId: string;
    clientId: string;
    remittanceId: string;
    traceNumber: string;
    remitClaimId: string;
    lineIds: string[];
    payment: remit.ClaimPayment;
    claim: typeof claims.$inferSelect;
    by: 'pcn' | 'payer_claim_number' | 'heuristic' | 'manual';
    actor: AuditActor;
    now: Date;
  },
): Promise<{ denied: boolean }> {
  const c = v.payment;
  await tx
    .update(remitClaims)
    .set({ claimId: v.claim.id, matchStatus: 'matched', matchedBy: v.by, updatedAt: v.now })
    .where(eq(remitClaims.id, v.remitClaimId));
  const lines = v.claim.currentVersionId
    ? await tx.select().from(claimLines).where(eq(claimLines.claimVersionId, v.claim.currentVersionId))
    : [];
  const lineMatches = matchLines(lines, c.lines);
  for (let i = 0; i < v.lineIds.length; i++)
    if (lineMatches[i])
      await tx
        .update(remitLines)
        .set({ claimLineId: lineMatches[i] })
        .where(eq(remitLines.id, v.lineIds[i]!));

  const outcome = remit.paymentOutcome(c);
  await applyPayment(tx, v.claim, c, outcome, {
    remittanceId: v.remittanceId,
    traceNumber: v.traceNumber,
    actor: v.actor,
    now: v.now,
  });
  // A payment on a corrected claim answers the denial it was built for (Flow 5).
  if (outcome.event !== 'reverse')
    await resolveAnsweredDenials(tx, v.claim, 'Corrected claim accepted', v.actor, v.now);
  if (!outcome.denials.length) return { denied: false };
  const worst = outcome.denials.reduce<remit.DenialCategory>(
    (w, d) => (remit.DENIAL_PRIORITY[d.category] < remit.DENIAL_PRIORITY[w] ? d.category : w),
    'other',
  );
  const codes = [...new Set(outcome.denials.map((d) => `${d.group}-${d.carc}`))].join(', ');
  const open = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(eq(workItems.claimId, v.claim.id), eq(workItems.type, 'denial'), ne(workItems.status, 'resolved')),
    );
  if (!open.length)
    await createWorkItem(
      tx,
      {
        tenantId: v.tenantId,
        clientId: v.clientId,
        type: 'denial',
        priority: remit.DENIAL_PRIORITY[worst],
        hours: 48,
        reasonCode: outcome.denials[0]!.carc,
        summary: `${c.statusCode === '4' || c.paidCents === 0 ? 'Denied' : 'Partly denied'}: ${codes}`,
        amountCents: outcome.denials.reduce((t, d) => t + d.amountCents, 0),
        claimId: v.claim.id,
        remittanceId: v.remittanceId,
        now: v.now,
      },
      v.actor,
    );
  return { denied: true };
}

export interface IngestContext {
  tenantId: string;
  clientId: string;
  source: 'pm' | 'file' | 'stedi';
  actor?: AuditActor;
  rawRef?: string | null;
}

/** The ingestion itself, inside the caller's tenant transaction (sync runs it per page). */
export async function ingestInTx(
  tx: Tx,
  ctx: IngestContext,
  r: remit.Remittance835,
  now: Date,
): Promise<IngestOutcome> {
  const actor: AuditActor = ctx.actor ?? 'automation:remit.ingest';
  const payerId = await payerOf(tx, r);
  const [row] = await tx
    .insert(remittances)
    .values({
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      payerId,
      payerName: r.payer.name,
      source: ctx.source,
      traceNumber: r.payment.traceNumber,
      paymentMethod: r.payment.method,
      paymentAmountCents: r.payment.amountCents,
      paymentDate: r.payment.paymentDate,
      rawRef: ctx.rawRef ?? null,
      status: 'received',
    })
    .onConflictDoNothing()
    .returning({ id: remittances.id });
  if (!row) {
    const [existing] = await tx
      .select({ id: remittances.id })
      .from(remittances)
      .where(
        and(
          eq(remittances.clientId, ctx.clientId),
          eq(remittances.payerName, r.payer.name),
          eq(remittances.traceNumber, r.payment.traceNumber),
          eq(remittances.paymentAmountCents, r.payment.amountCents),
          eq(remittances.paymentDate, r.payment.paymentDate),
        ),
      );
    await recordAudit(tx, {
      actor,
      action: 'remittance.duplicate_ignored',
      entityType: 'remittance',
      entityId: existing!.id,
      clientId: ctx.clientId,
      metadata: { source: ctx.source },
    });
    return { status: 'duplicate', remittanceId: existing!.id };
  }
  const remittanceId = row.id;
  let status = await move(tx, remittanceId, 'received', 'parse');

  // Store every claim, line, adjustment and remark as received.
  const stored: { id: string; payment: remit.ClaimPayment; lineIds: string[] }[] = [];
  for (const c of r.claims) {
    const [rc] = await tx
      .insert(remitClaims)
      .values({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        remittanceId,
        patientControlNumber: c.patientControlNumber,
        payerClaimControlNumber: c.payerClaimControlNumber,
        claimStatusCode: c.statusCode,
        chargeCents: c.chargeCents,
        paidCents: c.paidCents,
        patientRespCents: c.patientRespCents,
      })
      .returning({ id: remitClaims.id });
    const lineIds: string[] = [];
    for (const l of c.lines) {
      const [rl] = await tx
        .insert(remitLines)
        .values({
          tenantId: ctx.tenantId,
          clientId: ctx.clientId,
          remitClaimId: rc!.id,
          code: l.code,
          modifiers: l.modifiers,
          chargeCents: l.chargeCents,
          allowedCents: l.allowedCents,
          paidCents: l.paidCents,
          units: l.units,
          lineControlNumber: l.lineControlNumber,
        })
        .returning({ id: remitLines.id });
      lineIds.push(rl!.id);
      for (const a of l.adjustments)
        await tx.insert(remitAdjustments).values({
          tenantId: ctx.tenantId,
          clientId: ctx.clientId,
          remitLineId: rl!.id,
          groupCode: a.group,
          carc: a.carc,
          amountCents: a.amountCents,
          quantity: a.quantity ?? null,
        });
      for (const rarc of l.remarks)
        await tx
          .insert(remitRemarks)
          .values({ tenantId: ctx.tenantId, clientId: ctx.clientId, remitLineId: rl!.id, rarc });
    }
    for (const a of c.adjustments)
      await tx.insert(remitAdjustments).values({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        remitClaimId: rc!.id,
        groupCode: a.group,
        carc: a.carc,
        amountCents: a.amountCents,
        quantity: a.quantity ?? null,
      });
    for (const rarc of c.remarks)
      await tx
        .insert(remitRemarks)
        .values({ tenantId: ctx.tenantId, clientId: ctx.clientId, remitClaimId: rc!.id, rarc });
    stored.push({ id: rc!.id, payment: c, lineIds });
  }
  for (const p of r.providerAdjustments)
    await tx.insert(providerAdjustments).values({
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      remittanceId,
      reasonCode: p.reasonCode,
      reference: p.reference,
      amountCents: p.amountCents,
    });

  // Check 1: the 835 must balance before anything is matched.
  const balance = remit.balance835(r);
  if (!balance.balanced) {
    await move(tx, remittanceId, status, 'balance_fail');
    const difference =
      balance.remittanceDifferenceCents || balance.claims.reduce((s, c) => s + c.differenceCents, 0);
    await createWorkItem(
      tx,
      {
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        type: 'out_of_balance',
        priority: 1,
        hours: 24,
        reasonCode: 'BALANCE_835',
        summary: `835 does not balance: off by ${formatCents(Math.abs(difference))}${balance.claims.length ? ` on ${balance.claims.length} ${balance.claims.length === 1 ? 'claim' : 'claims'}` : ''}.`,
        amountCents: Math.abs(difference),
        remittanceId,
        now,
      },
      actor,
    );
    return { status: 'out_of_balance', remittanceId, differenceCents: difference };
  }
  status = await move(tx, remittanceId, status, 'balance_ok');

  let matched = 0;
  let unmatched = 0;
  let denied = 0;
  for (const s of stored) {
    const c = s.payment;
    const m = await matchClaim(tx, ctx.clientId, c);
    if (!m) {
      unmatched++;
      await createWorkItem(
        tx,
        {
          tenantId: ctx.tenantId,
          clientId: ctx.clientId,
          type: 'remit_unmatched',
          priority: 2,
          hours: 24,
          reasonCode: 'NO_MATCH',
          summary: `Payment for control number ${c.patientControlNumber} matches no claim.`,
          amountCents: c.paidCents,
          remittanceId,
          remitClaimId: s.id,
          now,
        },
        actor,
      );
      continue;
    }
    matched++;
    const res = await applyMatch(tx, {
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      remittanceId,
      traceNumber: r.payment.traceNumber,
      remitClaimId: s.id,
      lineIds: s.lineIds,
      payment: c,
      claim: m.claim,
      by: m.by,
      actor,
      now,
    });
    if (res.denied) denied++;
  }
  await tx
    .update(remitClaims)
    .set({ matchStatus: 'unmatched' })
    .where(and(eq(remitClaims.remittanceId, remittanceId), sql`${remitClaims.claimId} is null`));
  const final = await move(tx, remittanceId, status, unmatched ? 'match_some' : 'match_all');
  await recordAudit(tx, {
    actor,
    action: 'remittance.ingested',
    entityType: 'remittance',
    entityId: remittanceId,
    clientId: ctx.clientId,
    metadata: { source: ctx.source, claims: r.claims.length, matched, unmatched, denied },
  });
  return {
    status: 'ingested',
    remittanceId,
    matched,
    unmatched,
    denied,
    remittanceStatus: final as 'matched' | 'partially_matched',
  };
}

export async function ingestRemittance(
  deps: IngestDeps,
  ctx: IngestContext,
  r: remit.Remittance835,
): Promise<IngestOutcome> {
  const now = deps.now?.() ?? clockNow();
  const outcome = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) => ingestInTx(tx, ctx, r, now));
  deps.log.info({ remittanceId: outcome.remittanceId, status: outcome.status }, 'remittance ingested');
  return outcome;
}
