/**
 * `claim.build` (docs/04-modes.md step 3): for each encounter whose charge entry is complete, create
 * claim version 1, or a new version when a pulled change altered a claim that has not been
 * released. Each encounter is its own tenant transaction. Returns the versions that need a scrub.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  chargeLines,
  claims,
  claimVersions,
  clientPayerSettings,
  clients,
  coverages,
  diagnoses,
  encounters,
  locations,
  providers,
  withAudit,
  withTenant,
  type AuditActor,
  type Database,
  type Tx,
} from '@cleanpost/db';
import {
  buildClaimPayload,
  filingDeadline,
  readyToBuild,
  samePayload,
  state,
  type ClaimPayload,
  type EncounterForClaim,
} from '@cleanpost/domain';
import { applyClaimEvent } from './events';
import { resolveCorrectionTasks } from './tasks';
import { insertVersion, lastPmVersion } from './versions';

export interface BuildOptions {
  now?: Date;
  quietPeriodMinutes?: number;
  actor?: AuditActor;
}

export interface BuildResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: Record<string, number>;
  /** Claim versions to scrub next. */
  toScrub: string[];
  /** Claims created in this run (their charges are held in the PM next). */
  createdClaimIds: string[];
  /** Ready claims whose PM correction has now arrived: they can be released. */
  toRelease: string[];
}

const DEFAULT_FILING_DAYS = 90;

async function loadEncounter(
  tx: Tx,
  encounterId: string,
): Promise<(EncounterForClaim & { patientId: string }) | null> {
  const [e] = await tx.select().from(encounters).where(eq(encounters.id, encounterId));
  if (!e) return null;
  const lines = await tx
    .select()
    .from(chargeLines)
    .where(eq(chargeLines.encounterId, e.id))
    .orderBy(asc(chargeLines.lineNumber));
  const dx = await tx.select().from(diagnoses).where(eq(diagnoses.encounterId, e.id));
  const [prov] = e.renderingProviderId
    ? await tx.select().from(providers).where(eq(providers.id, e.renderingProviderId))
    : [];
  const [loc] = e.locationId ? await tx.select().from(locations).where(eq(locations.id, e.locationId)) : [];
  const [ref] = e.referringProviderId
    ? await tx.select({ npi: providers.npi }).from(providers).where(eq(providers.id, e.referringProviderId))
    : [];
  return {
    id: e.id,
    patientId: e.patientId,
    dateOfService: e.dateOfService,
    status: e.status as EncounterForClaim['status'],
    pmStatus: e.pmStatus,
    updatedAt: e.updatedAt,
    renderingProvider: prov ? { id: prov.id, npi: prov.npi, taxonomy: prov.taxonomy } : null,
    referringProviderNpi: ref?.npi ?? null,
    location: loc ? { id: loc.id, placeOfService: loc.placeOfService, npi: loc.npi } : null,
    priorAuthNumber: e.priorAuthNumber,
    diagnoses: dx.map((d) => ({ sequence: d.sequence, icd10: d.icd10 })),
    lines: lines.map((l) => ({
      id: l.id,
      lineNumber: l.lineNumber,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
      chargeCents: l.chargeCents,
      diagnosisPointers: l.diagnosisPointers,
      ndc: l.ndc,
    })),
  };
}

/** The patient's primary coverage in effect on the date of service. */
async function primaryCoverage(tx: Tx, patientId: string, dos: string) {
  const [c] = await tx
    .select({ id: coverages.id, payerId: coverages.payerId, payerName: coverages.payerName })
    .from(coverages)
    .where(
      and(
        eq(coverages.patientId, patientId),
        eq(coverages.priority, 1),
        or(isNull(coverages.effectiveDate), lte(coverages.effectiveDate, dos)),
        or(isNull(coverages.terminationDate), gte(coverages.terminationDate, dos)),
      ),
    )
    .orderBy(desc(coverages.updatedAt))
    .limit(1);
  return c ?? null;
}

type Outcome =
  | { kind: 'created' | 'updated'; versionId: string; claimId: string }
  | { kind: 'unchanged' }
  | { kind: 'caught_up'; claimId: string }
  | { kind: 'skipped'; reason: string };

async function buildOne(
  tx: Tx,
  client: typeof clients.$inferSelect,
  encounterId: string,
  opts: Required<Pick<BuildOptions, 'quietPeriodMinutes'>> & { now: Date; actor: AuditActor },
): Promise<Outcome> {
  const e = await loadEncounter(tx, encounterId);
  if (!e) return { kind: 'skipped', reason: 'not_found' };
  const ready = readyToBuild(e, opts.now, opts.quietPeriodMinutes);
  if (!ready.ok) return { kind: 'skipped', reason: ready.reason };

  const coverage = await primaryCoverage(tx, e.patientId, e.dateOfService);
  const [settings] = coverage?.payerId
    ? await tx
        .select()
        .from(clientPayerSettings)
        .where(
          and(eq(clientPayerSettings.clientId, client.id), eq(clientPayerSettings.payerId, coverage.payerId)),
        )
    : [];
  const payload = buildClaimPayload(e, {
    patientId: e.patientId,
    coverage,
    client: { billingNpi: client.billingNpi, taxonomy: client.taxonomy },
    timelyFilingDays: settings?.timelyFilingDays ?? DEFAULT_FILING_DAYS,
  });
  const mode = (settings?.modeOverride ?? client.defaultMode) as 'A' | 'B' | 'C';
  const claimFields = {
    payerId: coverage?.payerId ?? null,
    coverageId: coverage?.id ?? null,
    totalChargeCents: payload.totalChargeCents,
    balanceCents: payload.totalChargeCents,
    filingDeadline: filingDeadline(e.dateOfService, settings?.timelyFilingDays ?? DEFAULT_FILING_DAYS),
  };

  const [existing] = await tx.select().from(claims).where(eq(claims.encounterId, e.id)).for('update');
  if (!existing) {
    return withAudit(
      tx,
      (r: Outcome) => ({
        actor: opts.actor,
        action: 'claim.built',
        entityType: 'claim',
        entityId: r.kind === 'created' ? r.claimId : null,
        clientId: client.id,
        metadata: { encounterId: e.id, version: 1 },
      }),
      async () => {
        const [claim] = await tx
          .insert(claims)
          .values({
            tenantId: client.tenantId,
            clientId: client.id,
            patientId: e.patientId,
            encounterId: e.id,
            // Mode A: the PM's clearinghouse assigns the number sent to the payer (DEC-07).
            pcnSource: mode === 'A' ? 'pm' : 'cleanpost',
            status: 'draft',
            mode,
            ...claimFields,
          })
          .returning();
        const versionId = await insertVersion(tx, claim!, 1, payload, opts.actor);
        await tx.update(claims).set({ currentVersionId: versionId }).where(eq(claims.id, claim!.id));
        await applyClaimEvent(tx, claim!, 'build', { actor: opts.actor, versionId, now: opts.now });
        return { kind: 'created', versionId, claimId: claim!.id };
      },
    );
  }

  if (!state.isPreRelease(existing.status as state.ClaimState))
    return { kind: 'skipped', reason: 'released' };
  const [current] = existing.currentVersionId
    ? await tx.select().from(claimVersions).where(eq(claimVersions.id, existing.currentVersionId))
    : [];
  // A person's edit stays until the PM itself changes: compare with the last version built from
  // the PM, not with the edit (otherwise the next sync would undo the fix).
  const fromPm = await lastPmVersion(tx, existing.id);
  const pmChanged = !fromPm || !samePayload(fromPm.payload as ClaimPayload, payload);
  if (pmChanged && current) {
    // The PM was corrected (or changed for another reason): the correction task is done.
    await resolveCorrectionTasks(tx, existing.id, opts.actor, opts.now);
  }
  if (!pmChanged || (current && samePayload(current.payload as ClaimPayload, payload))) {
    // Caught up with a person's edit: the claim may now go, if it was waiting for that.
    const waiting = pmChanged && existing.status === 'ready';
    return waiting ? { kind: 'caught_up', claimId: existing.id } : { kind: 'unchanged' };
  }

  const versionId = await insertVersion(tx, existing, (current?.version ?? 0) + 1, payload, opts.actor);
  await tx
    .update(claims)
    .set({ currentVersionId: versionId, ...claimFields, updatedAt: opts.now })
    .where(eq(claims.id, existing.id));
  await applyClaimEvent(tx, existing, existing.status === 'draft' ? 'build' : 'edit', {
    actor: opts.actor,
    versionId,
    payload: { reason: 'pm_change' },
    now: opts.now,
  });
  await withAudit(
    tx,
    {
      actor: opts.actor,
      action: 'claim.version_built',
      entityType: 'claim',
      entityId: existing.id,
      clientId: client.id,
      metadata: { encounterId: e.id, version: (current?.version ?? 0) + 1, reason: 'pm_change' },
    },
    async () => undefined,
  );
  return { kind: 'updated', versionId, claimId: existing.id };
}

export async function buildClaimsForClient(
  db: Database,
  ctx: { tenantId: string; clientId: string },
  options: BuildOptions = {},
): Promise<BuildResult> {
  const now = options.now ?? new Date();
  const opts = {
    now,
    quietPeriodMinutes: options.quietPeriodMinutes ?? 120,
    actor: options.actor ?? ('automation:claim.build' as AuditActor),
  };
  const { client, candidates } = await withTenant(db, { tenantId: ctx.tenantId }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, ctx.clientId));
    const rows = c
      ? await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.clientId, ctx.clientId), inArray(encounters.status, ['open', 'ready'])))
          .orderBy(asc(encounters.dateOfService))
      : [];
    return { client: c, candidates: rows.map((r) => r.id) };
  });
  const result: BuildResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: {},
    toScrub: [],
    createdClaimIds: [],
    toRelease: [],
  };
  if (!client || client.status === 'offboarded') return result;
  for (const encounterId of candidates) {
    const outcome = await withTenant(db, { tenantId: ctx.tenantId }, (tx) =>
      buildOne(tx, client, encounterId, opts),
    );
    if (outcome.kind === 'skipped') {
      result.skipped[outcome.reason] = (result.skipped[outcome.reason] ?? 0) + 1;
    } else if (outcome.kind === 'unchanged') {
      result.unchanged++;
    } else if (outcome.kind === 'caught_up') {
      result.unchanged++;
      result.toRelease.push(outcome.claimId);
    } else {
      result[outcome.kind]++;
      result.toScrub.push(outcome.versionId);
      if (outcome.kind === 'created') result.createdClaimIds.push(outcome.claimId);
    }
  }
  return result;
}
