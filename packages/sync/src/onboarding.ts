/**
 * Onboarding (O-04, O-05): test a new connection, and a dry run, a read-only pull of the last days
 * that stores nothing but counts and names (`clients.onboarding`), so the admin can check the data
 * looks right before going live. Nothing is written to Cleanpost's records, the PM or a payer.
 */
import { eq } from 'drizzle-orm';
import type { AdapterRegistry } from '@cleanpost/adapters';
import { now as clockNow } from '@cleanpost/clock';
import { clients, connections, providers, recordAudit, withTenant, type Database } from '@cleanpost/db';
import { readOnboarding, spread, state, type DryRunSample, type DryRunSummary } from '@cleanpost/domain';
import type { Logger } from '@cleanpost/log';
import { toAdapterConnection } from './run';
import { applyConnectionEvent, lockConnection } from './state';

export interface OnboardingDeps {
  db: Database;
  registry: AdapterRegistry;
  log: Logger;
}

type Ctx = { tenantId: string; userId: string | null };

const actorOf = (ctx: Ctx) =>
  ctx.userId ? (`user:${ctx.userId}` as const) : ('automation:onboarding' as const);

/** O-04: the adapter's health check, kept on the client for the wizard. */
export async function testConnection(
  deps: OnboardingDeps,
  ctx: Ctx & { connectionId: string },
): Promise<{ ok: boolean; details: Record<string, string> }> {
  const now = clockNow();
  const [conn] = await withTenant(deps.db, { tenantId: ctx.tenantId }, (tx) =>
    tx.select().from(connections).where(eq(connections.id, ctx.connectionId)),
  );
  if (!conn) return { ok: false, details: { connection: 'not_found' } };
  let ok = false;
  let details: Record<string, string> = {};
  try {
    const res = await deps.registry.get(conn.adapterKey).healthCheck(toAdapterConnection(conn));
    ok = res.ok;
    details = Object.fromEntries(Object.entries(res.details).map(([k, v]) => [k, String(v)]));
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    details = { connection: code === 'AUTH_FAILED' ? 'auth_failed' : 'failing' };
    deps.log.warn({ connectionId: conn.id, code }, 'connection test failed');
  }
  await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, conn.clientId)).for('update');
    if (c)
      await tx
        .update(clients)
        .set({
          onboarding: {
            ...readOnboarding(c.onboarding),
            test: { ok, checkedAt: now.toISOString(), details },
          },
        })
        .where(eq(clients.id, c.id));
    // A live client's connection moves on when its test passes; while onboarding it stays in setup
    // until Go live, so no scheduled sync runs before then.
    if (ok && conn.status === 'setup' && c && c.status !== 'onboarding')
      await applyConnectionEvent(tx, conn, 'test_started', { actor: actorOf(ctx), now });
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'connection.tested',
      entityType: 'connection',
      entityId: conn.id,
      clientId: conn.clientId,
      metadata: { ok },
    });
  });
  return { ok, details };
}

/** O-05: read the last `days` of patients and charges from the PM; keep counts and names only. */
export async function dryRun(
  deps: OnboardingDeps,
  ctx: Ctx & { clientId: string },
  days = 7,
  maxPages = 20,
): Promise<DryRunSummary | null> {
  const now = clockNow();
  const since = new Date(now.getTime() - days * 86_400_000);
  const { conn, npis } = await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.clientId, ctx.clientId)).limit(1);
    const known = await tx
      .select({ npi: providers.npi })
      .from(providers)
      .where(eq(providers.clientId, ctx.clientId));
    return { conn: c, npis: new Set(known.map((k) => k.npi)) };
  });
  if (!conn) return null;
  const adapter = deps.registry.get(conn.adapterKey);
  const ac = toAdapterConnection(conn);
  let rejected = 0;
  // Charges first: the dry run is about the encounters of the last days and their patients.
  let encounters = 0;
  let lines = 0;
  const unknown = new Set<string>();
  const locations = new Set<string>();
  const onCharges = new Set<string>();
  const all: (DryRunSample & { patient: string })[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await adapter.pullCharges(ac, since, cursor);
    rejected += page.rejected?.length ?? 0;
    for (const e of page.items) {
      encounters++;
      lines += e.lines.length;
      locations.add(e.locationExternalId);
      onCharges.add(e.patientExternalId);
      for (const n of [e.renderingProviderNpi, e.referringProviderNpi]) if (n && !npis.has(n)) unknown.add(n);
      all.push({
        encounterId: e.externalId,
        codes: e.lines.map((l) => (l.modifiers.length ? `${l.code}-${l.modifiers.join('-')}` : l.code)),
        chargeCents: e.lines.reduce((sum, l) => sum + l.chargeCents, 0),
        payer: null,
        patient: e.patientExternalId,
      });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  // Then the patient list (not only those changed lately: a returning patient's record may be
  // old), keeping the payer names on the coverages of the patients seen on those charges. Held in
  // memory for the length of the run only.
  const payers = new Map<string, number>();
  const primaryPayer = new Map<string, string>();
  cursor = undefined;
  for (let i = 0; i < maxPages && primaryPayer.size < onCharges.size; i++) {
    const page = await adapter.pullPatientsAndCoverage(ac, new Date(0), cursor);
    rejected += page.rejected?.length ?? 0;
    for (const p of page.items) {
      if (!onCharges.has(p.externalId)) continue;
      for (const cov of new Set(p.coverages.map((c) => c.payerName)))
        payers.set(cov, (payers.get(cov) ?? 0) + 1);
      const primary = p.coverages.find((c) => c.priority === 1) ?? p.coverages[0];
      primaryPayer.set(p.externalId, primary?.payerName ?? '');
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const patients = onCharges.size;
  const summary: DryRunSummary = {
    ranAt: now.toISOString(),
    days,
    patients,
    encounters,
    lines,
    payers: [...payers.entries()]
      .map(([name, n]) => ({ name, patients: n }))
      .sort((a, b) => b.patients - a.patients || a.name.localeCompare(b.name)),
    unknownNpis: [...unknown].sort(),
    locations: [...locations].sort(),
    rejected,
    samples: spread(all, 10).map(({ patient, ...x }) => ({ ...x, payer: primaryPayer.get(patient) || null })),
  };
  await withTenant(deps.db, { tenantId: ctx.tenantId }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, ctx.clientId)).for('update');
    if (!c) return;
    await tx
      .update(clients)
      .set({ onboarding: { ...readOnboarding(c.onboarding), dryRun: summary, dryRunConfirmed: false } })
      .where(eq(clients.id, c.id));
    await recordAudit(tx, {
      actor: actorOf(ctx),
      action: 'client.dry_run',
      entityType: 'client',
      entityId: c.id,
      clientId: c.id,
      metadata: {
        days,
        patients,
        encounters,
        payers: summary.payers.length,
        unknownNpis: summary.unknownNpis.length,
      },
    });
  });
  deps.log.info({ clientId: ctx.clientId, patients, encounters }, 'dry run');
  return summary;
}

export type GoLiveResult =
  | { ok: true; connectionId: string | null; goLiveAt: Date }
  | { ok: false; reason: 'not_found' | 'invalid_state' };

/**
 * O-10 Go live: the client becomes live through its state machine, the connection that passed its
 * test moves to testing so scheduled syncs pick it up (they run for live and paused clients only),
 * and the time is recorded. The caller checks the go-live checklist first and queues the first sync.
 */
export async function goLive(
  db: Database,
  ctx: { tenantId: string; userId: string },
  clientId: string,
  now: Date,
): Promise<GoLiveResult> {
  const actor = `user:${ctx.userId}` as const;
  return withTenant(db, ctx, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, clientId)).for('update');
    if (!c) return { ok: false, reason: 'not_found' };
    const next = state.nextClientState(c.status as state.ClientState, 'go_live');
    if (!next.ok) return { ok: false, reason: 'invalid_state' };
    await tx
      .update(clients)
      .set({
        status: next.value,
        goLiveAt: now,
        onboarding: { ...readOnboarding(c.onboarding), step: 10, liveAt: now.toISOString() },
        updatedAt: now,
      })
      .where(eq(clients.id, c.id));
    const [first] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.clientId, c.id))
      .limit(1);
    const conn = first ? await lockConnection(tx, first.id) : undefined;
    if (conn?.status === 'setup' && conn.adapterKey !== 'manual')
      await applyConnectionEvent(tx, conn, 'test_started', { actor, now });
    await recordAudit(tx, {
      actor,
      action: 'client.went_live',
      entityType: 'client',
      entityId: c.id,
      clientId: c.id,
      metadata: { mode: c.defaultMode, threshold: c.autoReleaseThreshold, reviewUntil: c.reviewUntil },
    });
    return { ok: true, connectionId: conn?.id ?? null, goLiveAt: now };
  });
}
