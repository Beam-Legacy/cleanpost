/**
 * Claim status checks (276/277; C-15, W-15, docs/04-modes.md "Daily sweep"). A check asks the
 * payer, through Stedi (payer-sim before production), what it has for a claim; the answer is a
 * `status_277` claim event in plain codes and amounts. Works in every mode: the payer answers
 * whoever sent the claim. The daily sweep opens a follow-up (`no_response`) for claims with no
 * acknowledgment a week after sending, or no payment a month after acceptance, and checks open
 * follow-ups weekly; a person may check a claim once a day.
 *
 * The member ID is decrypted only inside an audited tenant transaction (CLAUDE.md rule 7); the call
 * happens outside it; nothing with PHI is logged or stored outside the database.
 */
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  claimEvents,
  claims,
  clients,
  connections,
  coverages,
  decryptField,
  encounters,
  manualTasks,
  patients,
  payers,
  recordAudit,
  remitClaims,
  withAudit,
  withTenant,
  workItems,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { claimStatus, formatCents } from '@cleanpost/domain';
import type { ClaimStatusClient } from '@cleanpost/eligibility';
import type { Logger } from '@cleanpost/log';
import { autoResolve, resolveFollowUps } from './answered';
import { applyClaimEvent } from './events';
import { now as clockNow } from '@cleanpost/clock';

export interface StatusCheckDeps {
  db: Database;
  client: ClaimStatusClient;
  log: Logger;
  now?: () => Date;
}

export type StatusTrigger = 'manual' | 'sweep' | 'retry';

export type StatusCheckOutcome =
  | {
      status: 'checked';
      result: claimStatus.ClaimStatusResult;
      kind: claimStatus.StatusKind;
      accepted: boolean;
    }
  | {
      status: 'refused';
      reason: 'not_found' | 'not_out' | 'rate_limited' | 'no_payer_id' | 'no_billing_npi' | 'no_coverage';
      lastAt?: Date;
    }
  | { status: 'failed'; retryable: boolean; code: string };

const DAY = 86_400_000;
const compact = (ymd: string) => ymd.replaceAll('-', '');
const shift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Claims a status check can ask about: the payer has them, or should. */
export const CHECKABLE = ['submitted', 'accepted'] as const;

/** The latest status check of a claim, or of a person (rate limit), within a window. */
async function lastCheck(tx: Tx, claimId: string, since: Date, manualOnly: boolean) {
  const [e] = await tx
    .select({ at: claimEvents.occurredAt })
    .from(claimEvents)
    .where(
      and(
        eq(claimEvents.claimId, claimId),
        eq(claimEvents.type, 'status_277'),
        gte(claimEvents.occurredAt, since),
        manualOnly ? sql`${claimEvents.payload}->>'trigger' = 'manual'` : undefined,
      ),
    )
    .orderBy(desc(claimEvents.occurredAt))
    .limit(1);
  return e?.at ?? null;
}

export async function checkClaimStatus(
  deps: StatusCheckDeps,
  ctx: { tenantId: string; claimId: string; trigger: StatusTrigger; userId?: string | null },
  opts: { timeoutMs?: number } = {},
): Promise<StatusCheckOutcome> {
  const now = deps.now?.() ?? clockNow();
  const actor: AuditActor = ctx.userId ? `user:${ctx.userId}` : 'automation:claim.statusCheck';
  const prepared = await withTenant(
    deps.db,
    { tenantId: ctx.tenantId, ...(ctx.userId ? { userId: ctx.userId } : {}) },
    async (tx) => {
      const [row] = await tx
        .select({
          claim: claims,
          patient: patients,
          coverage: coverages,
          payer: payers,
          client: clients,
          dos: encounters.dateOfService,
        })
        .from(claims)
        .innerJoin(patients, eq(patients.id, claims.patientId))
        .innerJoin(clients, eq(clients.id, claims.clientId))
        .innerJoin(encounters, eq(encounters.id, claims.encounterId))
        .leftJoin(coverages, eq(coverages.id, claims.coverageId))
        .leftJoin(payers, eq(payers.id, claims.payerId))
        .where(eq(claims.id, ctx.claimId));
      if (!row) return { refuse: 'not_found' as const };
      if (!(CHECKABLE as readonly string[]).includes(row.claim.status)) return { refuse: 'not_out' as const };
      if (ctx.trigger === 'manual') {
        const at = await lastCheck(
          tx,
          row.claim.id,
          new Date(now.getTime() - claimStatus.MANUAL_CHECK_HOURS * 3_600_000),
          true,
        );
        if (at) return { refuse: 'rate_limited' as const, lastAt: at };
      }
      if (!row.payer?.stediPayerId) return { refuse: 'no_payer_id' as const };
      if (!row.client.billingNpi) return { refuse: 'no_billing_npi' as const };
      if (!row.coverage) return { refuse: 'no_coverage' as const };
      const memberId = await withAudit(
        tx,
        {
          actor,
          action: 'coverage.member_id_read',
          entityType: 'coverage',
          entityId: row.coverage.id,
          clientId: row.claim.clientId,
          metadata: { purpose: 'claim_status_276', claimId: row.claim.id },
        },
        async () => decryptField(row.coverage!.memberIdEncrypted),
      );
      const today = now.toISOString().slice(0, 10);
      const end = shift(row.dos, 7) < today ? shift(row.dos, 7) : today;
      return {
        claim: row.claim,
        request: {
          tradingPartnerServiceId: row.payer.stediPayerId,
          billingProvider: { organizationName: row.client.name, npi: row.client.billingNpi },
          subscriber: {
            memberId,
            firstName: row.patient.firstName,
            lastName: row.patient.lastName,
            dateOfBirth: compact(row.patient.dob),
          },
          beginningDateOfService: compact(shift(row.dos, -7)),
          endDateOfService: compact(end),
        },
      };
    },
  );
  if ('refuse' in prepared)
    return {
      status: 'refused',
      reason: prepared.refuse!,
      ...('lastAt' in prepared && prepared.lastAt ? { lastAt: prepared.lastAt } : {}),
    };

  const res = await deps.client.check(prepared.request, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {});
  if (!res.ok) {
    deps.log.warn(
      { claimId: ctx.claimId, code: res.code, retryable: res.retryable },
      'claim status check failed',
    );
    return { status: 'failed', retryable: res.retryable, code: res.code };
  }

  return withTenant(
    deps.db,
    { tenantId: ctx.tenantId, ...(ctx.userId ? { userId: ctx.userId } : {}) },
    async (tx) => {
      const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId)).for('update');
      if (!claim) return { status: 'refused', reason: 'not_found' } as const;
      // The payer may return several claims for the patient and dates: ours by control number, then
      // by the payer's claim number, else the only one.
      const [known] = await tx
        .select({ ref: remitClaims.payerClaimControlNumber })
        .from(remitClaims)
        .where(and(eq(remitClaims.claimId, claim.id), ne(remitClaims.claimStatusCode, '22')))
        .limit(1);
      const result =
        res.claims.find(
          (c) => c.patientAccountNumber && c.patientAccountNumber === claim.patientControlNumber,
        ) ??
        res.claims.find((c) => known?.ref && c.payerClaimNumber === known.ref) ??
        (res.claims.length === 1 && !res.claims[0]!.patientAccountNumber ? res.claims[0] : undefined) ??
        notFound(now);
      const kind = claimStatus.statusKind(result.category);
      const payload = {
        trigger: ctx.trigger,
        source: deps.client.kind,
        category: result.category,
        code: result.code,
        entityCode: result.entityCode,
        effectiveDate: result.effectiveDate,
        payerClaimNumber: result.payerClaimNumber,
        submittedCents: result.submittedCents,
        paidCents: result.paidCents,
        paidDate: result.paidDate,
        checkNumber: result.checkNumber,
        checkIssueDate: result.checkIssueDate,
      };
      let accepted = false;
      if ((CHECKABLE as readonly string[]).includes(claim.status)) {
        await applyClaimEvent(tx, claim, 'status', {
          actor,
          versionId: claim.currentVersionId,
          payload,
          now,
        });
        // The payer has it although no 277CA came through: it was accepted.
        if (claim.status === 'submitted' && claimStatus.payerHasClaim(kind)) {
          await applyClaimEvent(tx, claim, 'accept', {
            actor,
            versionId: claim.currentVersionId,
            payload: { source: 'status_277' },
            now,
          });
          await resolveFollowUps(tx, claim, 'Payer accepted it', actor, now, ['no_ack']);
          accepted = true;
        }
      }
      await recordAudit(tx, {
        actor,
        action: 'claim.status_checked',
        entityType: 'claim',
        entityId: claim.id,
        clientId: claim.clientId,
        metadata: { trigger: ctx.trigger, category: result.category, code: result.code },
      });
      return { status: 'checked', result, kind, accepted } as const;
    },
  );
}

const notFound = (now: Date): claimStatus.ClaimStatusResult => ({
  category: 'A4',
  code: '35',
  entityCode: null,
  effectiveDate: now.toISOString().slice(0, 10),
  payerClaimNumber: null,
  patientAccountNumber: null,
  submittedCents: null,
  paidCents: null,
  paidDate: null,
  checkNumber: null,
  checkIssueDate: null,
});

export interface SweepResult {
  opened: number;
  closed: number;
  /** Claims with an open follow-up whose last check is a week old or more: check them now. */
  due: string[];
}

/**
 * The daily sweep for one tenant: follow-ups for claims the payer has not answered, closed again for
 * claims that moved on, and the claims to check.
 */
export async function statusSweep(
  db: Database,
  ctx: { tenantId: string },
  now = clockNow(),
): Promise<SweepResult> {
  const actor: AuditActor = 'automation:claim.statusSweep';
  return withTenant(db, { tenantId: ctx.tenantId }, async (tx) => {
    // Safety net: follow-ups on claims that are no longer out (paid, denied, voided...).
    const stale = await tx
      .select({ item: workItems, status: claims.status })
      .from(workItems)
      .innerJoin(claims, eq(claims.id, workItems.claimId))
      .where(and(eq(workItems.type, 'no_response'), ne(workItems.status, 'resolved')));
    let closed = 0;
    const moved = new Set(
      stale.filter((s) => !(CHECKABLE as readonly string[]).includes(s.status)).map((s) => s.item.claimId!),
    );
    for (const s of stale)
      if (moved.has(s.item.claimId!) && (await autoResolve(tx, s.item, 'Claim moved on', actor, now)))
        closed++;

    const out = await tx
      .select({ claim: claims, payerName: payers.name })
      .from(claims)
      .leftJoin(payers, eq(payers.id, claims.payerId))
      .where(inArray(claims.status, [...CHECKABLE]));
    if (!out.length) return { opened: 0, closed, due: [] };
    const times = await tx
      .select({
        claimId: claimEvents.claimId,
        released: sql<Date | null>`max(${claimEvents.occurredAt}) filter (where ${claimEvents.type} = 'released')`,
        accepted: sql<Date | null>`max(${claimEvents.occurredAt}) filter (where ${claimEvents.type} = 'ack_277ca')`,
        checked: sql<Date | null>`max(${claimEvents.occurredAt}) filter (where ${claimEvents.type} = 'status_277')`,
      })
      .from(claimEvents)
      .where(
        inArray(
          claimEvents.claimId,
          out.map((o) => o.claim.id),
        ),
      )
      .groupBy(claimEvents.claimId);
    const at = new Map(times.map((t) => [t.claimId, t]));
    const open = await tx
      .select({ claimId: workItems.claimId })
      .from(workItems)
      .where(and(eq(workItems.type, 'no_response'), ne(workItems.status, 'resolved')));
    const hasOpen = new Set(open.map((o) => o.claimId));
    const days = (d: Date | string | null | undefined) =>
      d ? Math.floor((now.getTime() - new Date(d).getTime()) / DAY) : null;

    let opened = 0;
    const due: string[] = [];
    for (const { claim, payerName } of out) {
      const t = at.get(claim.id);
      const payer = payerName ?? 'the payer';
      const sinceSent = days(t?.released);
      const sinceAccepted = days(t?.accepted);
      const reason =
        claim.status === 'submitted' && sinceSent !== null && sinceSent >= claimStatus.NO_ACK_DAYS
          ? {
              code: 'no_ack',
              summary: `No acknowledgment from ${payer} ${sinceSent} days after it was sent.`,
            }
          : claim.status === 'accepted' &&
              sinceAccepted !== null &&
              sinceAccepted >= claimStatus.NO_PAYMENT_DAYS
            ? { code: 'no_payment', summary: `No payment ${sinceAccepted} days after ${payer} accepted it.` }
            : null;
      if (reason && !hasOpen.has(claim.id)) {
        const [item] = await tx
          .insert(workItems)
          .values({
            tenantId: claim.tenantId,
            clientId: claim.clientId,
            type: 'no_response',
            priority: 3,
            dueAt: new Date(now.getTime() + 72 * 3_600_000),
            claimId: claim.id,
            encounterId: claim.encounterId,
            reasonCode: reason.code,
            summary: reason.summary,
            amountCents: Number(claim.balanceCents),
          })
          .returning({ id: workItems.id });
        await recordAudit(tx, {
          actor,
          action: 'work_item.created',
          entityType: 'work_item',
          entityId: item!.id,
          clientId: claim.clientId,
          metadata: { type: 'no_response', reason: reason.code, claimId: claim.id },
        });
        hasOpen.add(claim.id);
        opened++;
      }
      const sinceChecked = days(t?.checked);
      if (hasOpen.has(claim.id) && (sinceChecked === null || sinceChecked >= claimStatus.AUTO_CHECK_DAYS))
        due.push(claim.id);
    }
    return { opened, closed, due };
  });
}

/** C-15 / W-15 Create task: the task the latest status answer implies (records, resubmission). */
export async function createStatusTask(
  db: Database,
  ctx: { tenantId: string; userId: string; claimId: string },
  input: { advice: claimStatus.StatusAdvice },
  now = clockNow(),
): Promise<
  | { status: 'created'; workItemId: string }
  | { status: 'refused'; reason: 'no_task' | 'not_found' | 'exists' | 'no_connection' }
> {
  const task = input.advice.task;
  if (!task) return { status: 'refused', reason: 'no_task' };
  const actor: AuditActor = `user:${ctx.userId}`;
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, ctx.claimId));
    if (!claim) return { status: 'refused', reason: 'not_found' };
    const [exists] = await tx
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.claimId, claim.id),
          eq(workItems.type, 'manual_task'),
          eq(workItems.reasonCode, task.operation),
          ne(workItems.status, 'resolved'),
        ),
      );
    if (exists) return { status: 'refused', reason: 'exists' };
    const [conn] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.clientId, claim.clientId))
      .limit(1);
    if (!conn) return { status: 'refused', reason: 'no_connection' };
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        type: 'manual_task',
        priority: 2,
        dueAt: new Date(now.getTime() + 48 * 3_600_000),
        claimId: claim.id,
        encounterId: claim.encounterId,
        connectionId: conn.id,
        reasonCode: task.operation,
        summary: `${task.title}.`,
        amountCents: Number(claim.balanceCents),
      })
      .returning({ id: workItems.id });
    await tx.insert(manualTasks).values({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      connectionId: conn.id,
      operation: task.operation,
      workItemId: item!.id,
      title: task.title,
      instructions: [...task.instructions, `Open balance ${formatCents(Number(claim.balanceCents))}.`],
      payloadRef: claim.id,
    });
    await recordAudit(tx, {
      actor,
      action: 'work_item.created',
      entityType: 'work_item',
      entityId: item!.id,
      clientId: claim.clientId,
      metadata: { type: 'manual_task', operation: task.operation, claimId: claim.id },
    });
    return { status: 'created', workItemId: item!.id };
  });
}
