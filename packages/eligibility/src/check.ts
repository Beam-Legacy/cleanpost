/**
 * `eligibility.check` (docs/01-architecture.md, docs/04-modes.md step 2): ask the payer whether a
 * coverage is active on the date of service, and store the 271 summary that scrub step 2 reads.
 *
 * The member ID is decrypted only inside an audited tenant transaction (CLAUDE.md rule 7); the call
 * to Stedi happens outside it; the stored summary holds status, dates and cost sharing only. The
 * raw 271 goes to object storage when that exists (M3); until then only the summary is kept.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  claims,
  clients,
  coverages,
  decryptField,
  eligibilityChecks,
  encounters,
  patients,
  payers,
  recordAudit,
  withAudit,
  withTenant,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import type { Logger } from '@cleanpost/log';
import type { EligibilityClient } from './stedi';
import { now as clockNow } from '@cleanpost/clock';

export interface CheckDeps {
  db: Database;
  client: EligibilityClient;
  log: Logger;
  now?: () => Date;
}

export type CheckOutcome =
  | { status: 'checked'; result: 'active' | 'inactive' | 'error' | 'unknown'; checkId: string }
  | { status: 'skipped'; reason: 'not_found' | 'no_payer_id' | 'no_billing_npi' }
  | { status: 'failed'; retryable: boolean; code: string };

/** A check counts for this long; older coverage is checked again before the next scrub. */
export const CHECK_MAX_AGE_DAYS = 7;

const ACTOR: AuditActor = 'automation:eligibility.check';
const compact = (ymd: string) => ymd.replaceAll('-', '');

/** Coverages among these that have no check newer than CHECK_MAX_AGE_DAYS. */
export async function coveragesNeedingCheck(tx: Tx, coverageIds: string[], now: Date): Promise<string[]> {
  if (!coverageIds.length) return [];
  const since = new Date(now.getTime() - CHECK_MAX_AGE_DAYS * 86_400_000);
  const fresh = await tx
    .selectDistinct({ id: eligibilityChecks.coverageId })
    .from(eligibilityChecks)
    .where(
      and(inArray(eligibilityChecks.coverageId, coverageIds), gte(eligibilityChecks.requestedAt, since)),
    );
  const have = new Set(fresh.map((f) => f.id));
  return [...new Set(coverageIds)].filter((id) => !have.has(id));
}

/** Claim versions built and waiting for a scrub whose claim uses this coverage. */
export async function versionsWaitingOnCoverage(db: Database, tenantId: string, coverageId: string) {
  return withTenant(db, { tenantId }, async (tx) => {
    const rows = await tx
      .select({ id: claims.currentVersionId })
      .from(claims)
      .where(and(eq(claims.coverageId, coverageId), eq(claims.status, 'built')));
    return rows.map((r) => r.id).filter((id): id is string => Boolean(id));
  });
}

export async function checkCoverage(
  deps: CheckDeps,
  ctx: { tenantId: string; coverageId: string },
): Promise<CheckOutcome> {
  const now = deps.now?.() ?? clockNow();
  const prepared = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [row] = await tx
      .select({ coverage: coverages, patient: patients, payer: payers, client: clients })
      .from(coverages)
      .innerJoin(patients, eq(patients.id, coverages.patientId))
      .innerJoin(clients, eq(clients.id, coverages.clientId))
      .leftJoin(payers, eq(payers.id, coverages.payerId))
      .where(eq(coverages.id, ctx.coverageId));
    if (!row) return { skip: 'not_found' as const };
    if (!row.payer?.stediPayerId) return { skip: 'no_payer_id' as const };
    if (!row.client.billingNpi) return { skip: 'no_billing_npi' as const };
    // The date of service of the latest claim on this coverage, else today.
    const [latest] = await tx
      .select({ dos: encounters.dateOfService })
      .from(claims)
      .innerJoin(encounters, eq(encounters.id, claims.encounterId))
      .where(eq(claims.coverageId, ctx.coverageId))
      .orderBy(desc(encounters.dateOfService))
      .limit(1);
    const memberId = await withAudit(
      tx,
      {
        actor: ACTOR,
        action: 'coverage.member_id_read',
        entityType: 'coverage',
        entityId: row.coverage.id,
        clientId: row.coverage.clientId,
        metadata: { purpose: 'eligibility_270' },
      },
      async () => decryptField(row.coverage.memberIdEncrypted),
    );
    return {
      clientId: row.coverage.clientId,
      request: {
        tradingPartnerServiceId: row.payer.stediPayerId,
        provider: { organizationName: row.client.name, npi: row.client.billingNpi },
        subscriber: {
          memberId,
          dateOfBirth: compact(row.patient.dob),
          firstName: row.patient.firstName,
          lastName: row.patient.lastName,
        },
        dateOfService: compact(latest?.dos ?? now.toISOString().slice(0, 10)),
      },
    };
  });
  if ('skip' in prepared) return { status: 'skipped', reason: prepared.skip! };

  const res = await deps.client.check(prepared.request);
  if (!res.ok) {
    deps.log.warn(
      { coverageId: ctx.coverageId, code: res.code, retryable: res.retryable },
      'eligibility check failed',
    );
    if (res.retryable) return { status: 'failed', retryable: true, code: res.code };
  }
  const summary = res.ok ? res.summary : null;
  const status = summary?.status ?? 'error';
  const checkId = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [row] = await tx
      .insert(eligibilityChecks)
      .values({
        tenantId: ctx.tenantId,
        clientId: prepared.clientId,
        coverageId: ctx.coverageId,
        requestedAt: now,
        status,
        summary: {
          ...(summary ?? { errorCodes: [] }),
          source: deps.client.kind,
          ...(res.ok ? {} : { failure: res.code }),
        },
      })
      .returning({ id: eligibilityChecks.id });
    await recordAudit(tx, {
      actor: ACTOR,
      action: 'eligibility.checked',
      entityType: 'coverage',
      entityId: ctx.coverageId,
      clientId: prepared.clientId,
      metadata: { status, source: deps.client.kind, checkId: row!.id },
    });
    return row!.id;
  });
  deps.log.info({ coverageId: ctx.coverageId, status, source: deps.client.kind }, 'eligibility checked');
  return { status: 'checked', result: status, checkId };
}
