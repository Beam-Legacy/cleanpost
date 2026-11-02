import 'server-only';
/**
 * C-15 status check result and W-15 follow-up facts: the claim's latest 277 in plain words (rules,
 * never an LLM), when the next check may run, and how long this payer usually takes to pay.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { CHECKABLE } from '@cleanpost/claims';
import {
  claimEvents,
  claims,
  clients,
  connections,
  patients,
  payers,
  remitClaims,
  withAudit,
  withTenant,
  workItems,
  type Tx,
} from '@cleanpost/db';
import { claimStatus } from '@cleanpost/domain';
import { claimStatusClient } from '../claim-status';
import { getDb } from '../server';
import type { ActiveContext } from '../session';
import { patientLabel } from './labels';

export interface LastStatus {
  at: Date;
  trigger: string;
  source: string;
  result: claimStatus.ClaimStatusResult;
  advice: claimStatus.StatusAdvice;
}

export interface StatusView {
  claimId: string;
  claimStatus: string;
  payerName: string;
  patient: string | null;
  clientName: string;
  pcn: string | null;
  pmName: string;
  last: LastStatus | null;
  /** The claim is out (submitted or accepted): a check can ask about it. */
  canCheck: boolean;
  /** A person checked within the last day: the next manual check from then. */
  manualAfter: Date | null;
  /** The sweep checks claims with an open follow-up weekly. */
  nextAutoCheck: Date | null;
  /** The task the answer implies is already open. */
  taskOpen: boolean;
  /** A 276 can be sent from here (Stedi key, or payer-sim in local and preview). */
  configured: boolean;
}

const HOUR = 3_600_000;

function resultOf(p: Record<string, unknown>): claimStatus.ClaimStatusResult {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  return {
    category: s('category') ?? 'E0',
    code: s('code'),
    entityCode: s('entityCode'),
    effectiveDate: s('effectiveDate'),
    payerClaimNumber: s('payerClaimNumber'),
    patientAccountNumber: null,
    submittedCents: n('submittedCents'),
    paidCents: n('paidCents'),
    paidDate: s('paidDate'),
    checkNumber: s('checkNumber'),
    checkIssueDate: s('checkIssueDate'),
  };
}

/** The latest status answer for a claim, with the advice it gives now (the 835 may have come since). */
export async function lastStatus(
  tx: Tx,
  claim: { id: string; patientControlNumber: string | null },
  ctx: { payerName: string; pmName: string },
): Promise<LastStatus | null> {
  const [e] = await tx
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claim.id), eq(claimEvents.type, 'status_277')))
    .orderBy(desc(claimEvents.occurredAt))
    .limit(1);
  if (!e) return null;
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.category !== 'string') return null;
  const [arrived] = await tx
    .select({ id: remitClaims.id })
    .from(remitClaims)
    .where(and(eq(remitClaims.claimId, claim.id), ne(remitClaims.claimStatusCode, '22')))
    .limit(1);
  const result = resultOf(payload);
  return {
    at: e.occurredAt,
    trigger: String(payload.trigger ?? 'sweep'),
    source: String(payload.source ?? 'stedi'),
    result,
    advice: claimStatus.adviseStatus(result, {
      payerName: ctx.payerName,
      pmName: ctx.pmName,
      paymentArrived: Boolean(arrived),
      patientControlNumber: claim.patientControlNumber,
    }),
  };
}

export async function statusViewInTx(tx: Tx, claimId: string, now = new Date()): Promise<StatusView | null> {
  const [row] = await tx
    .select({ claim: claims, payerName: payers.name, patient: patients, clientName: clients.name })
    .from(claims)
    .innerJoin(clients, eq(clients.id, claims.clientId))
    .leftJoin(payers, eq(payers.id, claims.payerId))
    .leftJoin(patients, eq(patients.id, claims.patientId))
    .where(eq(claims.id, claimId));
  if (!row) return null;
  const [conn] = await tx
    .select({ settings: connections.settings })
    .from(connections)
    .where(eq(connections.clientId, row.claim.clientId))
    .limit(1);
  const pmName = ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM';
  const payerName = row.payerName ?? 'the payer';
  const last = await lastStatus(tx, row.claim, { payerName, pmName });
  const [manual] = await tx
    .select({ at: claimEvents.occurredAt })
    .from(claimEvents)
    .where(
      and(
        eq(claimEvents.claimId, claimId),
        eq(claimEvents.type, 'status_277'),
        sql`${claimEvents.payload}->>'trigger' = 'manual'`,
        sql`${claimEvents.occurredAt} > ${new Date(now.getTime() - claimStatus.MANUAL_CHECK_HOURS * HOUR)}`,
      ),
    )
    .orderBy(desc(claimEvents.occurredAt))
    .limit(1);
  const [followUp] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claimId),
        eq(workItems.type, 'no_response'),
        ne(workItems.status, 'resolved'),
      ),
    )
    .limit(1);
  const op = last?.advice.task?.operation;
  const [task] = op
    ? await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(
          and(
            eq(workItems.claimId, claimId),
            eq(workItems.type, 'manual_task'),
            eq(workItems.reasonCode, op),
            ne(workItems.status, 'resolved'),
          ),
        )
        .limit(1)
    : [];
  return {
    claimId,
    claimStatus: row.claim.status,
    payerName,
    patient: row.patient ? patientLabel(row.patient) : null,
    clientName: row.clientName,
    pcn: row.claim.patientControlNumber,
    pmName,
    last,
    canCheck: (CHECKABLE as readonly string[]).includes(row.claim.status),
    manualAfter: manual ? new Date(manual.at.getTime() + claimStatus.MANUAL_CHECK_HOURS * HOUR) : null,
    nextAutoCheck:
      followUp && (CHECKABLE as readonly string[]).includes(row.claim.status)
        ? new Date((last?.at ?? now).getTime() + claimStatus.AUTO_CHECK_DAYS * 24 * HOUR)
        : null,
    taskOpen: Boolean(task),
    configured: Boolean(claimStatusClient()),
  };
}

/** C-15: the status view for a claim. Names a patient, so the read is audited. */
export async function getStatusView(ctx: ActiveContext, claimId: string): Promise<StatusView | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    withAudit(
      tx,
      (v: StatusView | null) => ({
        actor: `user:${ctx.user.id}`,
        action: 'claim_status.viewed',
        entityType: 'claim',
        entityId: claimId,
        metadata: { checked: Boolean(v?.last) },
      }),
      () => statusViewInTx(tx, claimId),
    ),
  );
}

/**
 * W-15 "Moda usually pays in 18 days": the median days from acceptance to the payer's answer (paid
 * or denied) for this payer's claims answered in the last 180 days; null under five claims.
 */
export async function typicalDaysToPay(
  tx: Tx,
  payerId: string | null,
  now = new Date(),
): Promise<number | null> {
  if (!payerId) return null;
  const since = new Date(now.getTime() - 180 * 24 * HOUR);
  const res = await tx.execute<{ days: number | null; n: number }>(sql`
    with acc as (
      select claim_id, min(occurred_at) as at from claim_events where type = 'ack_277ca' group by claim_id
    ), ans as (
      select claim_id, min(occurred_at) as at from claim_events
      where type in ('paid', 'partially_paid', 'denied') group by claim_id
    )
    select percentile_cont(0.5) within group (order by extract(epoch from (ans.at - acc.at)) / 86400) as days,
           count(*)::int as n
    from acc join ans using (claim_id) join claims c on c.id = acc.claim_id
    where c.payer_id = ${payerId} and ans.at > ${since} and ans.at >= acc.at`);
  const r = res.rows[0];
  return r && r.n >= 5 && r.days !== null ? Math.round(Number(r.days)) : null;
}
