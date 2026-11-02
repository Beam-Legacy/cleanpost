/**
 * `claim.scrub` (docs/06-rules-and-ai.md): runs steps 1-7, then the AI review (step 8, warn
 * findings only), scores the claim and routes it: ready (auto), needs_review or blocked, each
 * through the claim state machine. Review and blocked claims get one open work item.
 *
 * Reads happen in one tenant transaction, the AI call outside any transaction, and the writes in a
 * second transaction that first checks the claim has not moved on (a newer version, an edit).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  chargeLines,
  claims,
  claimVersions,
  clientPayerSettings,
  clients,
  codeSets,
  coverages,
  eligibilityChecks,
  encounters,
  mueLimits,
  ncciEdits,
  patients,
  rules,
  scrubResults,
  withTenant,
  workItems,
  recordAudit,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import {
  runScrubSteps,
  ruleSchema,
  scoreClaim,
  state,
  type ClaimPayload,
  type Finding,
  type RuleDef,
  type ScrubInput,
} from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { applyClaimEvent } from './events';
import type { ClaimReviewer } from './review';

export interface ScrubDeps {
  db: Database;
  log: Logger;
  reviewer?: ClaimReviewer;
  now?: () => Date;
}

export type ScrubOutcome =
  | { status: 'scrubbed'; decision: state.ScrubDecision; confidence: number; findings: number }
  | { status: 'skipped'; reason: 'not_found' | 'stale' | 'not_built' };

const RELEASED: state.ClaimState[] = ['submitted', 'accepted', 'paid', 'partially_paid', 'denied', 'closed'];
const REVIEW_SLA_HOURS = 24;

function ageAt(dob: string, dos: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [y, m, d] = dos.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

async function loadRules(tx: Tx, tenantId: string): Promise<{ rules: RuleDef[]; version: string }> {
  const rows = await tx
    .select()
    .from(rules)
    .where(and(eq(rules.enabled, true), or(isNull(rules.tenantId), eq(rules.tenantId, tenantId))));
  const defs: RuleDef[] = [];
  for (const r of rows) {
    const parsed = ruleSchema.safeParse({
      id: r.key ?? r.id,
      name: r.name,
      scope: r.scope,
      clientId: r.clientId,
      payerId: r.payerId,
      kind: r.kind,
      severity: r.severity,
      weight: r.weight,
      condition: r.condition,
      action: r.action,
    });
    // A rule that no longer parses is skipped, never half-applied.
    if (parsed.success) defs.push(parsed.data);
  }
  const version = createHash('sha256')
    .update(
      rows
        .map((r) => `${r.id}:${r.version}:${r.enabled}`)
        .sort()
        .join('|'),
    )
    .digest('hex')
    .slice(0, 12);
  return { rules: defs, version: `rules-${version}` };
}

interface Loaded {
  claim: typeof claims.$inferSelect;
  version: typeof claimVersions.$inferSelect;
  input: ScrubInput;
  threshold: number;
  firstClaimForClientPayer: boolean;
  rulesVersion: string;
}

async function load(tx: Tx, claimVersionId: string, today: string): Promise<Loaded | ScrubOutcome> {
  const [version] = await tx.select().from(claimVersions).where(eq(claimVersions.id, claimVersionId));
  if (!version) return { status: 'skipped', reason: 'not_found' };
  const [claim] = await tx.select().from(claims).where(eq(claims.id, version.claimId));
  if (!claim) return { status: 'skipped', reason: 'not_found' };
  if (claim.currentVersionId !== version.id) return { status: 'skipped', reason: 'stale' };
  if (claim.status !== 'built') return { status: 'skipped', reason: 'not_built' };
  const payload = version.payload as ClaimPayload;
  const [client] = await tx.select().from(clients).where(eq(clients.id, claim.clientId));
  const [patient] = await tx
    .select({ dob: patients.dob, sex: patients.sex })
    .from(patients)
    .where(eq(patients.id, claim.patientId));
  const [cov] = claim.coverageId
    ? await tx.select().from(coverages).where(eq(coverages.id, claim.coverageId))
    : [];
  const [elig] = cov
    ? await tx
        .select()
        .from(eligibilityChecks)
        .where(eq(eligibilityChecks.coverageId, cov.id))
        .orderBy(desc(eligibilityChecks.requestedAt))
        .limit(1)
    : [];
  const [settings] = claim.payerId
    ? await tx
        .select()
        .from(clientPayerSettings)
        .where(
          and(
            eq(clientPayerSettings.clientId, claim.clientId),
            eq(clientPayerSettings.payerId, claim.payerId),
          ),
        )
    : [];

  const codes = [...new Set(payload.lines.map((l) => l.code))];
  const dx = [...new Set(payload.diagnoses.map((d) => d.icd10))];
  const known = await tx
    .select({ type: codeSets.type, code: codeSets.code })
    .from(codeSets)
    .where(inArray(codeSets.code, [...codes, ...dx]));
  const icd10 = new Map<string, { billable: boolean }>();
  const procedures = new Set<string>();
  for (const k of known) {
    if (k.type === 'icd10') icd10.set(k.code, { billable: true });
    else if (k.type === 'icd10_header') icd10.set(k.code, { billable: false });
    else if (k.type === 'cpt_code_only' || k.type === 'hcpcs') procedures.add(k.code);
  }
  // Until the full code sets are loaded, an empty table means "not loaded", not "unknown code".
  const [{ n: codeCount } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(codeSets);
  const ncci = codes.length
    ? await tx
        .select({
          column1: ncciEdits.column1Code,
          column2: ncciEdits.column2Code,
          modifierIndicator: ncciEdits.modifierIndicator,
        })
        .from(ncciEdits)
        .where(and(inArray(ncciEdits.column1Code, codes), inArray(ncciEdits.column2Code, codes)))
    : [];
  const mueRows = codes.length ? await tx.select().from(mueLimits).where(inArray(mueLimits.code, codes)) : [];

  // History: another live visit for the same patient and day, entered earlier or already billed by
  // the PM, with a code in common. Visits, not claims: the PM may have billed one without Cleanpost.
  const [enc] = await tx
    .select({ id: encounters.id, dos: encounters.dateOfService })
    .from(encounters)
    .where(eq(encounters.id, claim.encounterId));
  const sameDay = await tx
    .select({ id: encounters.id, pmStatus: encounters.pmStatus })
    .from(encounters)
    .where(
      and(
        eq(encounters.patientId, claim.patientId),
        eq(encounters.dateOfService, enc!.dos),
        ne(encounters.id, enc!.id),
        ne(encounters.status, 'void'),
      ),
    );
  const duplicates: ScrubInput['history']['duplicates'] = [];
  for (const other of sameDay) {
    const billedInPm = other.pmStatus === 'Approved' || other.pmStatus === 'billed';
    if (!(other.id < enc!.id || billedInPm)) continue;
    const lines = await tx
      .select({ code: chargeLines.code })
      .from(chargeLines)
      .where(eq(chargeLines.encounterId, other.id));
    const shared = lines.map((l) => l.code).filter((c) => codes.includes(c));
    if (shared.length) duplicates.push({ encounterId: other.id, codes: [...new Set(shared)] });
  }

  const priorForPayer = claim.payerId
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(claims)
        .where(
          and(
            eq(claims.clientId, claim.clientId),
            eq(claims.payerId, claim.payerId),
            inArray(claims.status, RELEASED),
            ne(claims.id, claim.id),
          ),
        )
    : [{ n: 0 }];

  const { rules: ruleDefs, version: rulesVersion } = await loadRules(tx, claim.tenantId);
  return {
    claim,
    version,
    rulesVersion,
    threshold: settings?.autoReleaseThresholdOverride ?? client?.autoReleaseThreshold ?? 90,
    firstClaimForClientPayer: (priorForPayer[0]?.n ?? 0) === 0,
    input: {
      clientId: claim.clientId,
      claim: payload,
      patient: {
        sex: (patient?.sex ?? 'U') as 'M' | 'F' | 'U',
        ageYears: patient ? ageAt(patient.dob, payload.dateOfService) : null,
      },
      coverage: cov
        ? {
            id: cov.id,
            payerId: cov.payerId,
            payerName: cov.payerName,
            effectiveDate: cov.effectiveDate,
            terminationDate: cov.terminationDate,
            memberIdPresent: Boolean(cov.memberIdLast4),
            relationship: cov.relationship,
            subscriberPresent: Boolean(cov.subscriber),
          }
        : null,
      eligibility: elig
        ? {
            status: elig.status as 'active' | 'inactive' | 'error' | 'unknown',
            checkedAt: elig.requestedAt,
            otherPayerName:
              ((elig.summary ?? {}) as { otherPayerName?: string | null }).otherPayerName ?? null,
          }
        : null,
      reference: codeCount > 0 ? { icd10, procedures } : { icd10: null, procedures: null },
      ncci,
      mue: Object.fromEntries(mueRows.map((m) => [m.code, m.maxUnits])),
      rules: ruleDefs,
      history: { duplicates },
      today,
    },
  };
}

/** Opens (or refreshes) the claim's review or blocked item; resolves the other kind. */
async function routeWorkItem(
  tx: Tx,
  claim: typeof claims.$inferSelect,
  decision: state.ScrubDecision,
  findings: Finding[],
  confidence: number,
  actor: AuditActor,
  now: Date,
  firstClaim = false,
) {
  const open = await tx
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.claimId, claim.id),
        inArray(workItems.type, ['claim_review', 'claim_blocked']),
        ne(workItems.status, 'resolved'),
      ),
    );
  const wanted = decision === 'review' ? 'claim_review' : decision === 'blocked' ? 'claim_blocked' : null;
  for (const item of open) {
    if (item.type === wanted) continue;
    const next = state.nextWorkItemState(item.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    await tx
      .update(workItems)
      .set({
        status: next.value,
        resolvedBy: actor,
        resolution: 'Superseded by a new scrub',
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(workItems.id, item.id));
  }
  if (!wanted) return;
  const firstBlock = findings.find((f) => f.severity === 'block');
  // The reason shown in the queue (W-01): the most important finding, in one line.
  const topWarn =
    findings.find((f) => f.severity === 'warn' && f.step !== 'ai') ??
    findings.find((f) => f.severity === 'warn');
  const summary =
    wanted === 'claim_blocked'
      ? `Blocked: ${firstBlock?.message ?? 'a check failed.'}`
      : topWarn
        ? topWarn.message
        : firstClaim
          ? `First claim for this client and payer (confidence ${confidence}).`
          : `Confidence ${confidence} is below the release threshold.`;
  const reasonCode =
    wanted === 'claim_blocked' ? (firstBlock?.ruleId ?? 'blocked') : 'confidence_below_threshold';
  const existing = open.find((i) => i.type === wanted);
  if (existing) {
    await tx
      .update(workItems)
      .set({ summary, reasonCode, updatedAt: now })
      .where(eq(workItems.id, existing.id));
    return;
  }
  const [item] = await tx
    .insert(workItems)
    .values({
      tenantId: claim.tenantId,
      clientId: claim.clientId,
      type: wanted,
      priority: 2,
      dueAt: new Date(now.getTime() + REVIEW_SLA_HOURS * 3_600_000),
      claimId: claim.id,
      encounterId: claim.encounterId,
      reasonCode,
      summary,
      amountCents: claim.totalChargeCents,
    })
    .returning({ id: workItems.id });
  await recordAudit(tx, {
    actor,
    action: 'work_item.created',
    entityType: 'work_item',
    entityId: item!.id,
    clientId: claim.clientId,
    metadata: { type: wanted, claimId: claim.id, reasonCode },
  });
}

export async function scrubVersion(
  deps: ScrubDeps,
  ctx: { tenantId: string; claimVersionId: string },
  actor: AuditActor = 'automation:claim.scrub',
): Promise<ScrubOutcome> {
  const now = deps.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const loaded = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) =>
    load(tx, ctx.claimVersionId, today),
  );
  if ('status' in loaded) return loaded;

  const steps = runScrubSteps(loaded.input);
  let findings = steps.findings;
  let aiSummary: string | null = null;
  if (deps.reviewer) {
    try {
      const review = await deps.reviewer.review(loaded.input, findings);
      if (review) {
        aiSummary = review.summary;
        // AI concerns are warnings only; they can never block a claim alone (docs/06).
        findings = [
          ...findings,
          ...review.concerns.map((c) => ({ ...c, step: 'ai' as const, severity: 'warn' as const })),
        ];
      }
    } catch (err) {
      deps.log.warn(
        { err, claimVersionId: ctx.claimVersionId },
        'AI review unavailable; scrubbed without it',
      );
    }
  }
  const score = scoreClaim(findings, {
    threshold: loaded.threshold,
    firstClaimForClientPayer: loaded.firstClaimForClientPayer,
    payerFirstPassRate: null,
  });

  return withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [claim] = await tx.select().from(claims).where(eq(claims.id, loaded.claim.id)).for('update');
    if (!claim || claim.currentVersionId !== ctx.claimVersionId)
      return { status: 'skipped', reason: 'stale' };
    if (claim.status !== 'built') return { status: 'skipped', reason: 'not_built' };
    const [result] = await tx
      .insert(scrubResults)
      .values({
        tenantId: claim.tenantId,
        clientId: claim.clientId,
        claimVersionId: ctx.claimVersionId,
        confidence: score.confidence,
        findings: {
          items: findings,
          routes: steps.routes,
          deductions: score.deductions,
          threshold: loaded.threshold,
        },
        aiSummary,
        decision: score.decision,
        rulesVersion: loaded.rulesVersion,
      })
      .returning({ id: scrubResults.id });
    await tx
      .update(claimVersions)
      .set({ scrubResultId: result!.id, updatedAt: now })
      .where(eq(claimVersions.id, ctx.claimVersionId));
    await applyClaimEvent(tx, claim, state.scrubEvent(score.decision), {
      actor,
      versionId: ctx.claimVersionId,
      payload: {
        decision: score.decision,
        confidence: score.confidence,
        scrubResultId: result!.id,
        findings: findings.length,
      },
      now,
    });
    await routeWorkItem(
      tx,
      claim,
      score.decision,
      findings,
      score.confidence,
      actor,
      now,
      loaded.firstClaimForClientPayer,
    );
    await recordAudit(tx, {
      actor,
      action: 'claim.scrubbed',
      entityType: 'claim',
      entityId: claim.id,
      clientId: claim.clientId,
      metadata: { decision: score.decision, confidence: score.confidence, findings: findings.length },
    });
    return {
      status: 'scrubbed',
      decision: score.decision,
      confidence: score.confidence,
      findings: findings.length,
    };
  });
}

// Re-exported for the worker: versions waiting for a scrub (e.g. after a restart).
export async function versionsAwaitingScrub(
  db: Database,
  tenantId: string,
  clientId: string,
): Promise<string[]> {
  return withTenant(db, { tenantId }, async (tx) => {
    const rows = await tx
      .select({ id: claims.currentVersionId })
      .from(claims)
      .where(and(eq(claims.clientId, clientId), eq(claims.status, 'built')));
    return rows.map((r) => r.id).filter((id): id is string => Boolean(id));
  });
}
