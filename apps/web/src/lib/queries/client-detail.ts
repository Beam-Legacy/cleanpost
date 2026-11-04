import 'server-only';
/**
 * CL-02 / CL-07: one client's header (status, mode, PM, connection, pause, baseline), what is open in
 * the queue for it, who works it, and its settings and system history. Totals and settings only; no
 * patient data, so reading these is not a PHI read.
 */
import { and, count, desc, eq, inArray, min, ne, sql } from 'drizzle-orm';
import {
  adjustmentMappings,
  auditEvents,
  clientPayerSettings,
  clients,
  connections,
  memberships,
  tenants,
  users,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { now as clockNow } from '@cleanpost/clock';
import {
  companyReleaseThreshold,
  effectiveReleaseThreshold,
  policy,
  readBaseline,
  remit,
  work,
  type ClientBaseline,
} from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface ClientPause {
  reason: string;
  note: string | null;
  resumeOn: string | null;
  pausedAt: string;
}

export interface ClientHeader {
  id: string;
  name: string;
  status: 'onboarding' | 'live' | 'paused' | 'offboarded';
  mode: 'A' | 'B' | 'C';
  pmName: string;
  connection: { id: string; status: string; lastSuccessAt: Date | null } | null;
  goLiveAt: Date | null;
  /** HH:MM:SS in the client's time zone, when the PM sends its daily batch. */
  pmBatchTime: string | null;
  timezone: string;
  pause: ClientPause | null;
  baseline: ClientBaseline | null;
  /** Effective release threshold (client's own or the company default; 100 while reviewing everything). */
  threshold: number;
  ownThreshold: boolean;
  /** Review everything through this date (YYYY-MM-DD), if set and not past. */
  reviewUntil: string | null;
  primaryBiller: string | null;
  backupBiller: string | null;
}

/** The client if the caller may see it (billers: their clients only), else null. */
export async function clientHeader(ctx: ActiveContext, id: string): Promise<ClientHeader | null> {
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) return null;
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, id));
    if (!c) return null;
    const [conn] = await tx.select().from(connections).where(eq(connections.clientId, id)).limit(1);
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format(clockNow());
    const ids = [c.primaryBillerId, c.backupBillerId].filter((x): x is string => Boolean(x));
    const people = ids.length
      ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    return {
      id: c.id,
      name: c.name,
      status: c.status as ClientHeader['status'],
      mode: c.defaultMode as ClientHeader['mode'],
      pmName: ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? '—',
      connection: conn ? { id: conn.id, status: conn.status, lastSuccessAt: conn.lastSuccessAt } : null,
      goLiveAt: c.goLiveAt,
      pmBatchTime: c.pmBatchTime,
      timezone: c.timezone,
      pause: (c.pause as ClientPause | null) ?? null,
      baseline: readBaseline(c.baseline),
      threshold: effectiveReleaseThreshold({
        client: c.autoReleaseThreshold,
        company: companyReleaseThreshold(t?.settings),
        reviewUntil: c.reviewUntil,
        today,
      }),
      ownThreshold: c.autoReleaseThreshold !== null,
      reviewUntil: c.reviewUntil && c.reviewUntil >= today ? c.reviewUntil : null,
      primaryBiller: names.get(c.primaryBillerId ?? '') ?? null,
      backupBiller: names.get(c.backupBillerId ?? '') ?? null,
    };
  });
}

export interface OpenGroup {
  key: string;
  label: string;
  count: number;
  /** Earliest due among them. */
  dueAt: Date | null;
}

export interface ClientTeam {
  billers: { name: string; role: string }[];
  /** Payers set up for the client (CL-05). */
  payers: number;
}

/** CL-02 "Open items" by W-01 group, and "Team and setup". */
export async function clientOverview(
  ctx: ActiveContext,
  id: string,
): Promise<{ open: OpenGroup[]; team: ClientTeam }> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const byType = await tx
      .select({ type: workItems.type, n: count(), due: min(workItems.dueAt) })
      .from(workItems)
      .where(and(eq(workItems.clientId, id), ne(workItems.status, 'resolved')))
      .groupBy(workItems.type);
    const hidden = policy.authorize(ctx.actor, 'users.manage').allowed ? [] : work.ADMIN_ONLY_TYPES;
    const open = work.WORK_TYPE_GROUPS.map((g) => {
      const rows = byType.filter(
        (r) =>
          (g.types as readonly string[]).includes(r.type) && !(hidden as readonly string[]).includes(r.type),
      );
      const dues = rows.map((r) => (r.due ? new Date(r.due) : null)).filter((d): d is Date => d !== null);
      return {
        key: g.key,
        label: g.label,
        count: rows.reduce((s, r) => s + r.n, 0),
        dueAt: dues.length ? new Date(Math.min(...dues.map((d) => d.getTime()))) : null,
      };
    }).filter((g) => g.count > 0);

    const members = await tx
      .select({
        name: users.name,
        role: memberships.role,
        scope: memberships.clientScope,
        ids: memberships.clientIds,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.status, 'active'), eq(memberships.role, 'biller')));
    const billers = members
      .filter((m) => m.scope === 'all' || m.ids.includes(id))
      .map((m) => ({ name: m.name, role: m.scope === 'all' ? 'Works every client' : 'Assigned' }))
      .sort(
        (a, b) =>
          Number(a.role !== 'Assigned') - Number(b.role !== 'Assigned') || a.name.localeCompare(b.name),
      );
    const [payers] = await tx
      .select({ n: count() })
      .from(clientPayerSettings)
      .where(eq(clientPayerSettings.clientId, id));
    return { open, team: { billers, payers: payers?.n ?? 0 } };
  });
}

export interface ActivityRow {
  id: string;
  at: Date;
  who: string;
  action: string;
  entityType: string;
  metadata: Record<string, unknown>;
}

/** CL-07: this client's settings, connection and status events (PHI views stay in S-13). */
export const ACTIVITY_KINDS = {
  settings: ['client', 'adjustment_mapping', 'rule', 'provider', 'location', 'client_payer'],
  connection: ['connection'],
} as const;

export async function clientActivity(
  ctx: ActiveContext,
  id: string,
  kind: 'all' | keyof typeof ACTIVITY_KINDS,
  limit = 100,
): Promise<ActivityRow[]> {
  const types: readonly string[] =
    kind === 'all' ? [...ACTIVITY_KINDS.settings, ...ACTIVITY_KINDS.connection] : ACTIVITY_KINDS[kind];
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({
        id: auditEvents.id,
        at: auditEvents.at,
        actor: auditEvents.actor,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        metadata: auditEvents.metadata,
        name: users.name,
      })
      .from(auditEvents)
      .leftJoin(users, sql`${auditEvents.actor} = 'user:' || ${users.id}::text`)
      .where(
        and(
          eq(auditEvents.clientId, id),
          inArray(auditEvents.entityType, [...types]),
          sql`${auditEvents.action} not like '%.viewed' and ${auditEvents.action} not like '%.revealed'`,
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      who: r.name ?? (r.actor.startsWith('automation:') ? 'Automation' : 'Cleanpost'),
      action: r.action,
      entityType: r.entityType,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  });
}

/* CL-03 Client settings ------------------------------------------------------------------------- */

export interface ClientSettingsData {
  /** The client's own threshold; null follows the company default. */
  threshold: number | null;
  company: number;
  reviewUntil: string | null;
  pmBatchTime: string | null;
  timezone: string;
  mode: 'A' | 'B' | 'C';
  primaryBillerId: string | null;
  backupBillerId: string | null;
  /** Who can be primary or backup: active billers who see this client, and admins. */
  people: { id: string; name: string; role: string }[];
}

export async function clientSettings(ctx: ActiveContext, id: string): Promise<ClientSettingsData | null> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [c] = await tx.select().from(clients).where(eq(clients.id, id));
    if (!c) return null;
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const members = await tx
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
    return {
      threshold: c.autoReleaseThreshold,
      company: companyReleaseThreshold(t?.settings),
      reviewUntil: c.reviewUntil,
      pmBatchTime: c.pmBatchTime ? c.pmBatchTime.slice(0, 5) : null,
      timezone: c.timezone,
      mode: c.defaultMode as ClientSettingsData['mode'],
      primaryBillerId: c.primaryBillerId,
      backupBillerId: c.backupBillerId,
      people: members
        .filter((m) => m.role === 'admin' || m.scope === 'all' || m.ids.includes(id))
        .map((m) => ({ id: m.id, name: m.name, role: m.role === 'admin' ? 'Admin' : 'Biller' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/* CL-04 Providers and locations ----------------------------------------------------------------- */

export interface ProviderRow {
  id: string;
  npi: string;
  name: string;
  taxonomy: string | null;
  role: string;
  /** Latest date of service on an encounter, YYYY-MM-DD. */
  lastSeen: string | null;
}

export interface LocationRow {
  id: string;
  name: string;
  address: { line1?: string; city?: string; state?: string; zip?: string } | null;
  placeOfService: string;
  npi: string | null;
  lastSeen: string | null;
}

export async function clientProviders(
  ctx: ActiveContext,
  id: string,
): Promise<{ providers: ProviderRow[]; locations: LocationRow[] }> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const p = await tx.execute<{
      id: string;
      npi: string;
      name: string;
      taxonomy: string | null;
      role: string;
      last_seen: string | null;
    }>(sql`select p.id, p.npi, p.name, p.taxonomy, p.role,
        (select max(e.date_of_service)::text from encounters e where e.rendering_provider_id = p.id) as last_seen
      from providers p where p.client_id = ${id} order by p.name`);
    const l = await tx.execute<{
      id: string;
      name: string;
      address: LocationRow['address'];
      place_of_service: string;
      npi: string | null;
      last_seen: string | null;
    }>(sql`select l.id, l.name, l.address, l.place_of_service, l.npi,
        (select max(e.date_of_service)::text from encounters e where e.location_id = l.id) as last_seen
      from locations l where l.client_id = ${id} order by l.name`);
    return {
      providers: p.rows.map((r) => ({
        id: r.id,
        npi: r.npi,
        name: r.name,
        taxonomy: r.taxonomy,
        role: r.role,
        lastSeen: r.last_seen,
      })),
      locations: l.rows.map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        placeOfService: r.place_of_service,
        npi: r.npi,
        lastSeen: r.last_seen,
      })),
    };
  });
}

/* CL-05 Payers ---------------------------------------------------------------------------------- */

export interface ClientPayerRow {
  id: string;
  payerName: string;
  pmPayerName: string | null;
  stediPayerId: string | null;
  modeOverride: string | null;
  timelyFilingDays: number;
  eraEnrollment: string;
  ediEnrollment: string;
  /** Claims to this payer with a date of service in the last 90 days. */
  claims90: number;
}

export async function clientPayers(ctx: ActiveContext, id: string): Promise<ClientPayerRow[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      payer_name: string;
      pm_payer_name: string | null;
      stedi_payer_id: string | null;
      mode_override: string | null;
      timely_filing_days: number;
      era: string;
      edi: string;
      claims90: number;
    }>(sql`select s.id, p.name as payer_name, s.pm_payer_name, p.stedi_payer_id, s.mode_override,
        s.timely_filing_days, s.era_enrollment_status as era, s.edi_enrollment_status as edi,
        (select count(*)::int from claims c join encounters e on e.id = c.encounter_id
          where c.client_id = s.client_id and c.payer_id = s.payer_id
            and e.date_of_service >= (app.now() - interval '90 days')::date) as claims90
      from client_payer_settings s join payers p on p.id = s.payer_id
      where s.client_id = ${id} order by claims90 desc, p.name`);
    return rows.rows.map((r) => ({
      id: r.id,
      payerName: r.payer_name,
      pmPayerName: r.pm_payer_name,
      stediPayerId: r.stedi_payer_id,
      modeOverride: r.mode_override,
      timelyFilingDays: r.timely_filing_days,
      eraEnrollment: r.era,
      ediEnrollment: r.edi,
      claims90: r.claims90,
    }));
  });
}

/* CL-06 Adjustment mappings for one client ------------------------------------------------------ */

export interface ClientMappingRow {
  groupCode: string;
  carc: string;
  pmCode: string | null;
  action: string | null;
  /** client: its own override; company: the company's for the PM; default: Cleanpost's; unmapped. */
  source: 'client' | 'company' | 'default' | 'unmapped';
  /** What applies without the client's override (shown on overrides). */
  fallback: string | null;
  waiting: boolean;
}

export async function clientMappings(
  ctx: ActiveContext,
  id: string,
): Promise<{ pmName: string; pmType: string | null; rows: ClientMappingRow[] }> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [conn] = await tx.select().from(connections).where(eq(connections.clientId, id)).limit(1);
    const pmName = ((conn?.settings ?? {}) as { pmName?: string }).pmName ?? 'the PM';
    if (!conn) return { pmName, pmType: null, rows: [] };
    const rows = await tx
      .select()
      .from(adjustmentMappings)
      .where(
        and(
          eq(adjustmentMappings.pmType, conn.adapterKey),
          sql`(${adjustmentMappings.clientId} is null or ${adjustmentMappings.clientId} = ${id})`,
        ),
      );
    const waiting = await tx
      .select({ pair: workItems.reasonCode })
      .from(workItems)
      .where(
        and(
          eq(workItems.clientId, id),
          eq(workItems.type, 'mapping_needed'),
          ne(workItems.status, 'resolved'),
        ),
      );
    const out = new Map<string, ClientMappingRow>();
    const blank = (g: string, c: string): ClientMappingRow => ({
      groupCode: g,
      carc: c,
      pmCode: null,
      action: null,
      source: 'unmapped',
      fallback: null,
      waiting: false,
    });
    for (const [pair, m] of Object.entries(remit.DEFAULT_ADJUSTMENT_MAPPINGS)) {
      const [g, c] = pair.split('-') as [string, string];
      out.set(pair, { ...blank(g, c), pmCode: m.pmAdjustmentCode, action: m.action, source: 'default' });
    }
    for (const r of rows.filter((x) => x.clientId === null)) {
      const k = `${r.groupCode}-${r.carc}`;
      out.set(k, {
        ...(out.get(k) ?? blank(r.groupCode, r.carc)),
        pmCode: r.pmAdjustmentCode,
        action: r.action,
        source: 'company',
      });
    }
    for (const r of rows.filter((x) => x.clientId === id)) {
      const k = `${r.groupCode}-${r.carc}`;
      const base = out.get(k) ?? blank(r.groupCode, r.carc);
      out.set(k, {
        ...base,
        pmCode: r.pmAdjustmentCode,
        action: r.action,
        source: 'client',
        fallback: base.pmCode
          ? `${base.pmCode} (${base.source === 'company' ? 'company' : 'Cleanpost default'})`
          : 'Not mapped',
      });
    }
    for (const w of waiting) {
      const [g, c] = w.pair.split('-') as [string, string];
      const row = out.get(w.pair) ?? blank(g, c);
      out.set(w.pair, { ...row, waiting: true });
    }
    const sorted = [...out.values()].sort(
      (a, b) =>
        Number(b.waiting) - Number(a.waiting) ||
        a.groupCode.localeCompare(b.groupCode) ||
        a.carc.localeCompare(b.carc, 'en', { numeric: true }),
    );
    return { pmName, pmType: conn.adapterKey, rows: sorted };
  });
}
