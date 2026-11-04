import 'server-only';
/**
 * CL-02 / CL-07: one client's header (status, mode, PM, connection, pause, baseline), what is open in
 * the queue for it, who works it, and its settings and system history. Totals and settings only; no
 * patient data, so reading these is not a PHI read.
 */
import { and, count, desc, eq, inArray, min, ne, sql } from 'drizzle-orm';
import {
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
import { companyReleaseThreshold, policy, readBaseline, work, type ClientBaseline } from '@cleanpost/domain';
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
  /** Effective release threshold (client's own or the company default). */
  threshold: number;
  ownThreshold: boolean;
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
      threshold: c.autoReleaseThreshold ?? companyReleaseThreshold(t?.settings),
      ownThreshold: c.autoReleaseThreshold !== null,
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
  settings: ['client', 'adjustment_mapping', 'rule'],
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
