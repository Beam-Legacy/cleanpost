import 'server-only';
/**
 * Settings queries (S-01 users and roles; S-13 audit log). Users and memberships are not patient
 * data; the audit log's metadata never holds patient data either (packages/db audit).
 */
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { auditEvents, clients, memberships, passkeys, sessions, users, withTenant } from '@cleanpost/db';
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
}

/** S-01: everyone with a membership in this company, owner first, then by name. */
export async function listMembers(ctx: ActiveContext): Promise<MemberRow[]> {
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select({ m: memberships, u: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId));
    const ids = rows.map((r) => r.u.id);
    const [names, keys, last] = await Promise.all([
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
    ]);
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
