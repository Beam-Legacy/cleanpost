import 'server-only';
/**
 * O-01 to O-11: one client being onboarded, everything the wizard's steps show, and the go-live
 * facts the checklist is computed from. Practice and setup data only, no patient data; the tax ID
 * is never decrypted here (the wizard keeps only its last four digits).
 */
import { and, count, eq, gte, inArray, ne } from 'drizzle-orm';
import {
  clientPayerSettings,
  clients,
  connections,
  locations,
  memberships,
  payers,
  providers,
  syncRuns,
  users,
  withTenant,
  workItems,
  claims,
  tenants,
} from '@cleanpost/db';
import {
  ONBOARDING_STEPS,
  companyReleaseThreshold,
  goLiveChecklist,
  readOnboarding,
  type ChecklistItem,
  type OnboardingState,
} from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface OnboardingClient {
  id: string;
  name: string;
  status: string;
  taxIdLast4: string | null;
  billingNpi: string | null;
  taxonomy: string | null;
  address: { line1?: string; city?: string; state?: string; zip?: string } | null;
  timezone: string;
  mode: string;
  threshold: number | null;
  reviewUntil: string | null;
  primaryBillerId: string | null;
  backupBillerId: string | null;
  state: OnboardingState;
  updatedAt: Date;
  goLiveAt: Date | null;
  connection: {
    id: string;
    adapterKey: string;
    status: string;
    pmName: string;
    practiceId: string | null;
  } | null;
  renderingProviders: number;
  locations: number;
  /** Payer names the client has set up, as the PM names them. */
  payersSetUp: { payerId: string; pmPayerName: string | null; timelyFilingDays: number }[];
}

export async function onboardingClient(ctx: ActiveContext, id: string): Promise<OnboardingClient | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, id));
    if (!c) return null;
    const [conn] = await tx.select().from(connections).where(eq(connections.clientId, id)).limit(1);
    const [rp] = await tx
      .select({ n: count() })
      .from(providers)
      .where(and(eq(providers.clientId, id), eq(providers.role, 'rendering')));
    const [lc] = await tx.select({ n: count() }).from(locations).where(eq(locations.clientId, id));
    const set = await tx
      .select({
        payerId: clientPayerSettings.payerId,
        pmPayerName: clientPayerSettings.pmPayerName,
        timelyFilingDays: clientPayerSettings.timelyFilingDays,
      })
      .from(clientPayerSettings)
      .where(eq(clientPayerSettings.clientId, id));
    const state = readOnboarding(c.onboarding);
    const settings = (conn?.settings ?? {}) as { pmName?: string; practiceId?: string };
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      taxIdLast4: state.taxIdLast4 ?? null,
      billingNpi: c.billingNpi,
      taxonomy: c.taxonomy,
      address: c.address as OnboardingClient['address'],
      timezone: c.timezone,
      mode: c.defaultMode,
      threshold: c.autoReleaseThreshold,
      reviewUntil: c.reviewUntil,
      primaryBillerId: c.primaryBillerId,
      backupBillerId: c.backupBillerId,
      state,
      updatedAt: c.updatedAt,
      goLiveAt: c.goLiveAt,
      connection: conn
        ? {
            id: conn.id,
            adapterKey: conn.adapterKey,
            status: conn.status,
            pmName: settings.pmName ?? conn.adapterKey,
            practiceId: settings.practiceId ?? null,
          }
        : null,
      renderingProviders: rp?.n ?? 0,
      locations: lc?.n ?? 0,
      payersSetUp: set,
    };
  });
}

/** O-06: every payer, to match the PM's payer names to. */
export async function payerChoices(ctx: ActiveContext) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({
        id: payers.id,
        name: payers.name,
        aliases: payers.aliases,
        stediPayerId: payers.stediPayerId,
      })
      .from(payers)
      .orderBy(payers.name),
  );
}

/** O-10: active admins and billers who can work the client, for primary and backup. */
export async function billerChoices(ctx: ActiveContext, clientId: string) {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({
        id: users.id,
        name: users.name,
        role: memberships.role,
        scope: memberships.clientScope,
        ids: memberships.clientIds,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.status, 'active'), inArray(memberships.role, ['admin', 'biller'])));
    return rows
      .filter((r) => r.role === 'admin' || r.scope === 'all' || r.ids.includes(clientId))
      .map((r) => ({ id: r.id, name: r.name, role: r.role === 'admin' ? 'Admin' : 'Biller' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface PayerMatchRow {
  pmName: string;
  patients: number | null;
  /** Saved for this client, or the suggestion from payer names and aliases. */
  payerId: string | null;
  saved: boolean;
  timelyFilingDays: number | null;
}

/**
 * O-06: each payer name the dry run found, with what is saved for it or the payer whose name or
 * alias matches. Without a dry run (a manual PM), the payers set up so far.
 */
export function payerMatches(
  c: OnboardingClient,
  choices: { id: string; name: string; aliases: string[] }[],
): PayerMatchRow[] {
  const byName = new Map<string, string>();
  for (const p of choices)
    for (const n of [p.name, ...p.aliases]) if (!byName.has(norm(n))) byName.set(norm(n), p.id);
  const saved = new Map(c.payersSetUp.map((p) => [norm(p.pmPayerName ?? ''), p]));
  const found = c.state.dryRun?.payers;
  if (!found)
    return c.payersSetUp.map((p) => ({
      pmName: p.pmPayerName ?? choices.find((x) => x.id === p.payerId)?.name ?? '',
      patients: null,
      payerId: p.payerId,
      saved: true,
      timelyFilingDays: p.timelyFilingDays,
    }));
  return found.map((f) => {
    const s = saved.get(norm(f.name));
    return {
      pmName: f.name,
      patients: f.patients,
      payerId: s?.payerId ?? byName.get(norm(f.name)) ?? null,
      saved: Boolean(s),
      timelyFilingDays: s?.timelyFilingDays ?? null,
    };
  });
}

export interface FirstSync {
  /** running | succeeded | failed | waiting (not picked up yet) */
  status: 'waiting' | 'running' | 'succeeded' | 'failed';
  finishedAt: Date | null;
  patients: number;
  encounters: number;
  errorDetail: string | null;
  claims: number;
  waitingForReview: number;
}

/** O-11: the first sync since go-live, and what it made. Counts only. */
export async function firstSync(ctx: ActiveContext, clientId: string, since: Date): Promise<FirstSync> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const runs = await tx
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.clientId, clientId), gte(syncRuns.startedAt, since)))
      .orderBy(syncRuns.startedAt);
    const n = (op: string) =>
      runs
        .filter((r) => r.operation === op && r.status === 'succeeded')
        .reduce((sum, r) => {
          const k = (r.counts ?? {}) as { new?: number; changed?: number; unchanged?: number };
          return sum + (k.new ?? 0) + (k.changed ?? 0) + (k.unchanged ?? 0);
        }, 0);
    const failed = runs.find((r) => r.status === 'failed');
    const status: FirstSync['status'] = !runs.length
      ? 'waiting'
      : runs.some((r) => r.status === 'running')
        ? 'running'
        : failed && !runs.some((r) => r.status === 'succeeded' && r.operation === 'pullCharges')
          ? 'failed'
          : 'succeeded';
    const [cl] = await tx.select({ n: count() }).from(claims).where(eq(claims.clientId, clientId));
    const [wi] = await tx
      .select({ n: count() })
      .from(workItems)
      .where(
        and(
          eq(workItems.clientId, clientId),
          eq(workItems.type, 'claim_review'),
          ne(workItems.status, 'resolved'),
        ),
      );
    return {
      status,
      finishedAt: runs.at(-1)?.finishedAt ?? null,
      patients: n('pullPatientsAndCoverage'),
      encounters: n('pullCharges'),
      errorDetail: failed?.errorDetail ?? null,
      claims: cl?.n ?? 0,
      waitingForReview: wi?.n ?? 0,
    };
  });
}

/** O-10: the docs/13 checklist from what was saved. */
export function checklistFor(c: OnboardingClient): ChecklistItem[] {
  const names = new Set(c.payersSetUp.map((p) => norm(p.pmPayerName ?? '')));
  const unmatched = (c.state.dryRun?.payers ?? []).filter((p) => !names.has(norm(p.name))).length;
  return goLiveChecklist({
    practiceComplete: Boolean(c.billingNpi && c.taxIdLast4 && c.address?.line1),
    renderingProviders: c.renderingProviders,
    locations: c.locations,
    connectionTested:
      Boolean(c.state.test?.ok) ||
      (c.connection?.adapterKey === 'manual' && c.state.pm?.adapterKey === 'manual'),
    dryRunConfirmed: Boolean(c.state.dryRunConfirmed) || c.state.pm?.adapterKey === 'manual',
    unmatchedPayers: unmatched,
    payersSetUp: c.payersSetUp.length,
    modeChosen: Boolean(c.state.modeChosen),
    postingReviewed: Boolean(c.state.postingReviewed),
    automationSet: Boolean(c.state.automationSet),
    primaryBiller: Boolean(c.primaryBillerId),
    backupBiller: Boolean(c.backupBillerId),
    practiceInformed: Boolean(c.state.practiceInformed),
  });
}

/** O-09: the company's default release threshold (S-04). */
export async function companyThreshold(ctx: ActiveContext): Promise<number> {
  const [t] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, ctx.tenantId)),
  );
  return companyReleaseThreshold(t?.settings);
}

/** Where an onboarding client's wizard resumes: the furthest step reached. */
export async function resumeHref(ctx: ActiveContext, clientId: string): Promise<string | null> {
  const [c] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ status: clients.status, onboarding: clients.onboarding })
      .from(clients)
      .where(eq(clients.id, clientId)),
  );
  if (!c || c.status !== 'onboarding') return null;
  const step = ONBOARDING_STEPS[readOnboarding(c.onboarding).step - 1] ?? ONBOARDING_STEPS[0];
  return `/clients/new/${step.key}?client=${clientId}`;
}
