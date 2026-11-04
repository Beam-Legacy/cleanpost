import 'server-only';
/**
 * Settings queries (S-01 users and roles; S-13 audit log). Users and memberships are not patient
 * data; the audit log's metadata never holds patient data either (packages/db audit).
 */
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import {
  adjustmentMappings,
  auditEvents,
  clients,
  connections,
  invitations,
  memberships,
  passkeys,
  sessions,
  tenants,
  users,
  withTenant,
  workItems,
} from '@cleanpost/db';
import { companyReleaseThreshold, remit, reports as r, state } from '@cleanpost/domain';
import { getAutomationReport, todayPacific } from '@cleanpost/reports';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface MemberRow {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'biller' | 'viewer';
  isOwner: boolean;
  /** 'all', or the names of the clients this member sees. */
  clients: 'all' | string[];
  clientIds: string[];
  status: 'active' | 'invited' | 'deactivated';
  twoFactor: 'passkey' | 'authenticator' | null;
  lastActiveAt: Date | null;
  deactivatedAt: Date | null;
  /** S-03 */
  joinedAt: Date;
  /** Their signed-in sessions with this company open. */
  sessions: number;
  /** Work items assigned to them and not resolved. */
  openItems: number;
  /** Active in another company too (two-factor is then theirs to manage, DEC-22). */
  elsewhere: boolean;
}

export interface InviteRow {
  id: string;
  email: string;
  role: MemberRow['role'];
  clients: 'all' | string[];
  invitedBy: string;
  expiresAt: Date;
  expired: boolean;
}

/** S-01: invites not yet accepted or withdrawn, newest first; past 7 days they show as expired. */
export async function listInvitations(ctx: ActiveContext, now: Date): Promise<InviteRow[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({ i: invitations, by: users.name })
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(eq(invitations.status, 'pending'))
      .orderBy(desc(invitations.createdAt));
    const names = rows.length ? await tx.select({ id: clients.id, name: clients.name }).from(clients) : [];
    const clientName = new Map(names.map((c) => [c.id, c.name]));
    return rows.map(({ i, by }) => ({
      id: i.id,
      email: i.email,
      role: i.role as MemberRow['role'],
      clients:
        i.clientScope === 'all' ? ('all' as const) : i.clientIds.map((id) => clientName.get(id) ?? 'Client'),
      invitedBy: by,
      expiresAt: i.expiresAt,
      expired: state.invitationExpired(i.expiresAt, now),
    }));
  });
}

/** The company's name, for S-03's wording. */
export async function tenantName(ctx: ActiveContext): Promise<string> {
  const [t] = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId)),
  );
  return t?.name ?? 'this company';
}

/** S-02 / S-03: the clients a biller or viewer can be given, by name (offboarded ones left out). */
export async function listClientChoices(ctx: ActiveContext): Promise<{ id: string; name: string }[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(sql`${clients.status} <> 'offboarded'`)
      .orderBy(clients.name),
  );
}

/** S-01: everyone with a membership in this company, owner first, then by name. */
export async function listMembers(ctx: ActiveContext): Promise<MemberRow[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({ m: memberships, u: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId));
    const ids = rows.map((r) => r.u.id);
    const [names, keys, last, here, open, elsewhere] = await Promise.all([
      tx.select({ id: clients.id, name: clients.name }).from(clients),
      ids.length
        ? tx.select({ userId: passkeys.userId }).from(passkeys).where(inArray(passkeys.userId, ids))
        : Promise.resolve([]),
      ids.length
        ? tx
            .select({ userId: sessions.userId, at: sql<Date>`max(${sessions.updatedAt})` })
            .from(sessions)
            .where(inArray(sessions.userId, ids))
            .groupBy(sessions.userId)
        : Promise.resolve([]),
      ids.length
        ? tx
            .select({ userId: sessions.userId, n: sql<number>`count(*)::int` })
            .from(sessions)
            .where(
              and(
                inArray(sessions.userId, ids),
                eq(sessions.activeTenantId, ctx.tenantId),
                sql`${sessions.expiresAt} > now()`,
              ),
            )
            .groupBy(sessions.userId)
        : Promise.resolve([]),
      tx
        .select({ userId: workItems.assigneeId, n: sql<number>`count(*)::int` })
        .from(workItems)
        .where(sql`${workItems.assigneeId} is not null and ${workItems.status} <> 'resolved'`)
        .groupBy(workItems.assigneeId),
      ids.length
        ? tx.execute<{ id: string }>(
            sql`select u.id from unnest(array[${sql.join(
              ids.map((i) => sql`${i}::uuid`),
              sql`, `,
            )}]) as u(id) where app.member_elsewhere(u.id)`,
          )
        : Promise.resolve({ rows: [] as { id: string }[] }),
    ]);
    const sessionsHere = new Map(here.map((h) => [h.userId, h.n]));
    const openBy = new Map(open.map((o) => [o.userId, o.n]));
    const multi = new Set(elsewhere.rows.map((r) => r.id));
    const clientName = new Map(names.map((c) => [c.id, c.name]));
    const withPasskey = new Set(keys.map((k) => k.userId));
    const lastBy = new Map(last.map((l) => [l.userId, l.at ? new Date(l.at) : null]));
    const out = rows.map(({ m, u }) => ({
      membershipId: m.id,
      userId: u.id,
      name: u.name,
      email: u.email,
      role: m.role as MemberRow['role'],
      isOwner: m.isOwner,
      clients:
        m.clientScope === 'all' ? ('all' as const) : m.clientIds.map((id) => clientName.get(id) ?? 'Client'),
      clientIds: m.clientIds,
      status: m.status as MemberRow['status'],
      twoFactor: withPasskey.has(u.id)
        ? ('passkey' as const)
        : u.twoFactorEnabled
          ? ('authenticator' as const)
          : null,
      lastActiveAt: lastBy.get(u.id) ?? null,
      deactivatedAt: m.status === 'deactivated' ? m.updatedAt : null,
      joinedAt: m.createdAt,
      sessions: sessionsHere.get(u.id) ?? 0,
      openItems: openBy.get(u.id) ?? 0,
      elsewhere: multi.has(u.id),
    }));
    return out.sort((a, b) =>
      a.isOwner !== b.isOwner
        ? a.isOwner
          ? -1
          : 1
        : a.status !== b.status && (a.status === 'deactivated' || b.status === 'deactivated')
          ? a.status === 'deactivated'
            ? 1
            : -1
          : a.name.localeCompare(b.name),
    );
  });
}

// ---------- S-13 audit log ----------

export interface AuditFilters {
  /** user:<id>, automation, or null for anyone. */
  who: string | null;
  action: string | null;
  record: string | null;
  days: 1 | 7 | 30 | 90;
  /** A record ID (exact). */
  id: string | null;
  page: number;
}

export interface AuditRow {
  id: string;
  at: Date;
  actor: string;
  who: string;
  action: string;
  entityType: string;
  entityId: string | null;
  clientName: string | null;
  ip: string | null;
  metadata: unknown;
}

export const AUDIT_PAGE = 50;

function auditWhere(f: AuditFilters, since: Date, until: Date): SQL | undefined {
  return and(
    gte(auditEvents.at, since),
    lte(auditEvents.at, until),
    f.who === 'automation'
      ? sql`${auditEvents.actor} not like 'user:%'`
      : f.who
        ? eq(auditEvents.actor, f.who)
        : undefined,
    f.action ? eq(auditEvents.action, f.action) : undefined,
    f.record ? eq(auditEvents.entityType, f.record) : undefined,
    f.id ? eq(auditEvents.entityId, f.id) : undefined,
  );
}

export async function listAudit(
  ctx: ActiveContext,
  f: AuditFilters,
  now: Date,
  limit = AUDIT_PAGE,
): Promise<{
  rows: AuditRow[];
  total: number;
  actions: string[];
  records: string[];
  people: { actor: string; name: string }[];
}> {
  const since = new Date(now.getTime() - f.days * 86_400_000);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const where = auditWhere(f, since, now);
    const [rows, count, actions, records, people, names] = await Promise.all([
      tx
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(limit)
        .offset((f.page - 1) * limit),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(where),
      tx.selectDistinct({ a: auditEvents.action }).from(auditEvents).where(gte(auditEvents.at, since)),
      tx.selectDistinct({ r: auditEvents.entityType }).from(auditEvents).where(gte(auditEvents.at, since)),
      tx
        .select({ id: users.id, name: users.name })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)),
      tx.select({ id: clients.id, name: clients.name }).from(clients),
    ]);
    const nameOf = new Map(people.map((p) => [`user:${p.id}`, p.name]));
    const clientOf = new Map(names.map((c) => [c.id, c.name]));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actor: r.actor,
        who: nameOf.get(r.actor) ?? (r.actor.startsWith('user:') ? 'Former user' : actorLabel(r.actor)),
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        clientName: r.clientId ? (clientOf.get(r.clientId) ?? null) : null,
        ip: r.ip,
        metadata: r.metadata,
      })),
      total: count[0]?.n ?? 0,
      actions: actions.map((a) => a.a).sort(),
      records: records.map((r) => r.r).sort(),
      people: people
        .map((p) => ({ actor: `user:${p.id}`, name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

function actorLabel(actor: string): string {
  if (actor === 'system') return 'System';
  if (actor.startsWith('operator:')) return 'Cleanpost support';
  return 'Automation';
}

/** For the export: the same filters, every row up to a cap (no paging). */
export const AUDIT_EXPORT_CAP = 10_000;

/* S-08 Adjustment mappings ---------------------------------------------------------------------- */

const PM_FALLBACK: Record<string, string> = {
  mock: 'Mock PM',
  tebra: 'Tebra',
  manual: 'Manual entry',
  file: 'File import',
  athenaone: 'athenaOne',
  advancedmd: 'AdvancedMD',
  simplepractice: 'SimplePractice',
};

export interface PmTab {
  pmType: string;
  pmName: string;
  clients: number;
  unmapped: number;
}

export interface MappingRow {
  groupCode: string;
  carc: string;
  pmCode: string | null;
  action: remit.MappingAction | null;
  /** yours: the company's mapping; default: Cleanpost's built-in; unmapped: lines wait for one. */
  source: 'yours' | 'default' | 'unmapped';
  /** Clients with their own mapping for this code (set from W-19 or the client's settings). */
  overrides: number;
  /** Open "map this code" items, one per client waiting. */
  waiting: number;
}

/** S-08: the PM types in use, and for one of them every code with its mapping and what waits. */
export async function listMappings(
  ctx: ActiveContext,
  wanted: string | undefined,
): Promise<{ tabs: PmTab[]; pmType: string | null; rows: MappingRow[] }> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const conns = await tx
      .select({
        pmType: connections.adapterKey,
        clientId: connections.clientId,
        settings: connections.settings,
      })
      .from(connections);
    const waiting = await tx
      .select({ clientId: workItems.clientId, pair: workItems.reasonCode })
      .from(workItems)
      .where(and(eq(workItems.type, 'mapping_needed'), sql`${workItems.status} <> 'resolved'`));
    const typeOf = new Map(conns.map((c) => [c.clientId, c.pmType]));
    const byType = new Map<string, PmTab>();
    for (const c of conns) {
      const t = byType.get(c.pmType) ?? {
        pmType: c.pmType,
        pmName: ((c.settings ?? {}) as { pmName?: string }).pmName ?? PM_FALLBACK[c.pmType] ?? c.pmType,
        clients: 0,
        unmapped: 0,
      };
      t.clients++;
      byType.set(c.pmType, t);
    }
    const waitingByType = new Map<string, Map<string, number>>();
    for (const w of waiting) {
      const t = w.clientId ? typeOf.get(w.clientId) : undefined;
      if (!t) continue;
      const m = waitingByType.get(t) ?? new Map<string, number>();
      m.set(w.pair, (m.get(w.pair) ?? 0) + 1);
      waitingByType.set(t, m);
    }
    for (const [t, m] of waitingByType) {
      const tab = byType.get(t);
      if (tab) tab.unmapped = m.size;
    }
    const tabs = [...byType.values()].sort((a, b) => a.pmName.localeCompare(b.pmName));
    const pmType = tabs.find((t) => t.pmType === wanted)?.pmType ?? tabs[0]?.pmType ?? null;
    if (!pmType) return { tabs, pmType, rows: [] };

    const rows = await tx.select().from(adjustmentMappings).where(eq(adjustmentMappings.pmType, pmType));
    const out = new Map<string, MappingRow>();
    const key = (g: string, c: string) => `${g}-${c}`;
    const blank = (g: string, c: string): MappingRow => ({
      groupCode: g,
      carc: c,
      pmCode: null,
      action: null,
      source: 'unmapped',
      overrides: 0,
      waiting: 0,
    });
    for (const [pair, m] of Object.entries(remit.DEFAULT_ADJUSTMENT_MAPPINGS)) {
      const [g, c] = pair.split('-') as [string, string];
      out.set(pair, { ...blank(g, c), pmCode: m.pmAdjustmentCode, action: m.action, source: 'default' });
    }
    for (const r of rows) {
      const k = key(r.groupCode, r.carc);
      const row = out.get(k) ?? blank(r.groupCode, r.carc);
      if (r.clientId) row.overrides++;
      else {
        row.pmCode = r.pmAdjustmentCode;
        row.action = r.action as remit.MappingAction;
        row.source = 'yours';
      }
      out.set(k, row);
    }
    for (const [pair, n] of waitingByType.get(pmType) ?? []) {
      const [g, c] = pair.split('-') as [string, string];
      const row = out.get(pair) ?? blank(g, c);
      row.waiting = n;
      out.set(pair, row);
    }
    const sorted = [...out.values()].sort(
      (a, b) =>
        Number(b.source === 'unmapped') - Number(a.source === 'unmapped') ||
        a.groupCode.localeCompare(b.groupCode) ||
        a.carc.localeCompare(b.carc, 'en', { numeric: true }),
    );
    return { tabs, pmType, rows: sorted };
  });
}

/* S-04 Automation ------------------------------------------------------------------------------- */

export interface AutomationClient {
  id: string;
  name: string;
  /** null: follows the company default. */
  threshold: number | null;
  /** Last 30 days. */
  releasedWithoutReview: number | null;
  autoFirstPass: number | null;
}

export interface AutomationSettings {
  company: number;
  clients: AutomationClient[];
  /** Last 30 days' first scrub scores, for the simulation. */
  scores: number[];
  scrubbed: number;
}

export async function automationSettings(ctx: ActiveContext): Promise<AutomationSettings> {
  const period = r.periodFor('last_30', todayPacific());
  const [base, report] = await Promise.all([
    withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
      const [t] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId));
      const list = await tx
        .select({ id: clients.id, name: clients.name, threshold: clients.autoReleaseThreshold })
        .from(clients)
        .where(sql`${clients.status} <> 'offboarded'`)
        .orderBy(clients.name);
      return { company: companyReleaseThreshold(t?.settings), list };
    }),
    getAutomationReport(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id, clients: 'all' }, period),
  ]);
  const byClient = new Map(report.clients.map((c) => [c.clientId, c]));
  return {
    company: base.company,
    clients: base.list.map((c) => {
      const s = byClient.get(c.id);
      return {
        ...c,
        releasedWithoutReview: s ? r.rate(s.auto, s.released) : null,
        autoFirstPass: s ? r.rate(s.autoFirstPass.accepted, s.autoFirstPass.total) : null,
      };
    }),
    scores: report.scores,
    scrubbed: report.scrubbed,
  };
}
