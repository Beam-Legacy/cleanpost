/**
 * The notification sweep (G-04, E-04, E-05, docs/13 "Notifications"), run by the worker every 15
 * minutes for each company:
 *
 * 1. Timely-filing watch (docs/08): a claim the payer has not accepted, within 14 days of its filing
 *    limit, becomes a priority 1 `timely_filing_risk` item; the item resolves itself once the payer
 *    accepts the claim.
 * 2. Alerts from what is true now: a failed connection, an 835 out of balance over the company's
 *    amount, a filing limit within 3 days, a priority 1 item past its SLA, a denial over the amount,
 *    a client whose first sync after go-live finished. Each becomes one in-app notification per
 *    person (a dedupe key per alert), per S-09's channels and audience.
 * 3. E-05 urgent emails for alerts still true: outside quiet hours (timely filing excepted), at most
 *    every 4 hours, never to someone who switched them off (admins' connection and timely-filing
 *    emails excepted).
 * 4. E-04 digests at each person's digest time, once a day, skipped when there is nothing to say.
 * 5. E-06 once a newly live client's first sync finished, with its counts.
 *
 * Emails carry no PHI: client and payer names, counts and totals, and a link into the app.
 */
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  clients,
  memberships,
  notificationRules,
  notifications,
  recordAudit,
  tenants,
  userPreferences,
  users,
  withTenant,
  workItems,
  type Database,
  type Tx,
} from '@cleanpost/db';
import { formatCents, notify, readOnboarding, state, work } from '@cleanpost/domain';
import { alertEmail, clientLiveEmail, digestEmail, type Mailer } from '@cleanpost/email';
import type { Logger } from '@cleanpost/log';
import { getOverview } from '@cleanpost/reports';

type NotifyEventType = notify.NotifyEvent;

export interface NotifyDeps {
  db: Database;
  log: Logger;
  /** Without a mailer (or app URL) the sweep still makes in-app notifications and items. */
  mailer?: Mailer;
  /** The app's origin for links in emails, e.g. https://app.cleanpost.example. */
  appUrl?: string;
}

export interface SweepResult {
  itemsOpened: number;
  itemsResolved: number;
  notified: number;
  alertEmails: number;
  digests: number;
  liveEmails: number;
}

const ACTOR = 'automation:notifications' as const;
const WATCH_ACTOR = 'automation:timely_filing_watch' as const;
/** Claims the payer has not accepted yet: a filing limit still applies to them. */
export const FILING_RISK_STATUSES = [
  'draft',
  'built',
  'needs_review',
  'blocked',
  'on_hold',
  'ready',
  'submitted',
  'rejected',
] as const;

/** Every active company (`app.active_tenants()`: IDs only, the worker's one cross-tenant read for this). */
export async function listActiveTenants(db: Database): Promise<string[]> {
  const res = await db.execute<{ tenant_id: string }>(sql`select tenant_id from app.active_tenants()`);
  return res.rows.map((r) => r.tenant_id);
}

export async function sweepAll(deps: NotifyDeps, now: Date): Promise<SweepResult> {
  const total: SweepResult = {
    itemsOpened: 0,
    itemsResolved: 0,
    notified: 0,
    alertEmails: 0,
    digests: 0,
    liveEmails: 0,
  };
  for (const tenantId of await listActiveTenants(deps.db)) {
    try {
      const r = await sweepTenant(deps, tenantId, now);
      for (const k of Object.keys(total) as (keyof SweepResult)[]) total[k] += r[k];
    } catch (err) {
      deps.log.error({ err, tenantId }, 'notification sweep failed for a company');
    }
  }
  return total;
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  scope: string;
  clientIds: string[];
  digestEmail: boolean;
  alertEmail: boolean;
  lastDigestOn: string | null;
  digestTime: string | null;
}

const sees = (m: Member, clientId: string | null) =>
  m.role === 'admin' || m.scope === 'all' || (clientId !== null && m.clientIds.includes(clientId));

interface Alert {
  event: NotifyEventType;
  key: string;
  clientId: string | null;
  entityType: string;
  entityId: string;
  link: string;
  summary: string;
  detail: string | null;
  assigneeId: string | null;
  email: { kind: string; title: string; body: string; action: string };
}

interface Context {
  tenantName: string;
  timeZone: string;
  settings: notify.CompanyNotifySettings;
  members: Member[];
  local: { date: string; time: string };
}

async function loadContext(tx: Tx, tenantId: string, now: Date): Promise<Context> {
  const [t] = await tx
    .select({ name: tenants.name, timezone: tenants.timezone, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const rules = await tx.select().from(notificationRules);
  const rows = await tx
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      scope: memberships.clientScope,
      clientIds: memberships.clientIds,
      digestEmail: userPreferences.digestEmail,
      alertEmail: userPreferences.alertEmail,
      lastDigestOn: userPreferences.lastDigestOn,
      digestTime: userPreferences.digestTime,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      userPreferences,
      and(eq(userPreferences.userId, memberships.userId), eq(userPreferences.tenantId, memberships.tenantId)),
    )
    .where(eq(memberships.status, 'active'));
  const timeZone = t?.timezone ?? 'America/Los_Angeles';
  return {
    tenantName: t?.name ?? 'your company',
    timeZone,
    settings: notify.companySettings(rules, t?.settings),
    members: rows.map((r) => ({
      ...r,
      digestEmail: r.digestEmail ?? true,
      alertEmail: r.alertEmail ?? true,
      digestTime: r.digestTime ? r.digestTime.slice(0, 5) : null,
    })),
    local: notify.localNow(now, timeZone),
  };
}

/* 1. Timely-filing watch ------------------------------------------------------------------------- */

async function timelyFilingWatch(tx: Tx, tenantId: string, today: string, now: Date) {
  const horizon = notify.addDays(today, notify.TIMELY_FILING_ITEM_DAYS);
  const atRisk = await tx.execute<{
    id: string;
    client_id: string;
    filing_deadline: string;
    payer: string | null;
  }>(sql`
    select c.id, c.client_id, c.filing_deadline::text as filing_deadline, p.name as payer
    from claims c left join payers p on p.id = c.payer_id
    where c.status in (${sql.join(
      FILING_RISK_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    )})
      and c.filing_deadline is not null and c.filing_deadline <= ${horizon}::date
      and not exists (select 1 from work_items w where w.claim_id = c.id
        and w.type = 'timely_filing_risk' and w.status <> 'resolved')`);
  let opened = 0;
  for (const c of atRisk.rows) {
    const days = Math.round((Date.parse(c.filing_deadline) - Date.parse(today)) / 86_400_000);
    const [item] = await tx
      .insert(workItems)
      .values({
        tenantId,
        clientId: c.client_id,
        type: 'timely_filing_risk',
        priority: 1,
        dueAt: new Date(now.getTime() + 4 * 3_600_000),
        claimId: c.id,
        reasonCode: days < 0 ? 'FILING_LIMIT_PASSED' : 'FILING_LIMIT_NEAR',
        summary:
          days < 0
            ? `Filing limit with ${c.payer ?? 'the payer'} passed on ${notify.shortDate(c.filing_deadline)}.`
            : `Must reach ${c.payer ?? 'the payer'} by ${notify.shortDate(c.filing_deadline)} (${days === 1 ? '1 day' : `${days} days`} left).`,
      })
      .returning({ id: workItems.id });
    await recordAudit(tx, {
      actor: WATCH_ACTOR,
      action: 'work_item.created',
      entityType: 'work_item',
      entityId: item!.id,
      clientId: c.client_id,
      metadata: { type: 'timely_filing_risk', daysLeft: days },
    });
    opened++;
  }
  // Items whose claim the payer has since accepted (or that were voided) resolve themselves.
  const settled = await tx.execute<{
    id: string;
    status: string;
    client_id: string | null;
    claim_status: string;
  }>(sql`
    select w.id, w.status, w.client_id, c.status as claim_status
    from work_items w join claims c on c.id = w.claim_id
    where w.type = 'timely_filing_risk' and w.status <> 'resolved'
      and c.status not in (${sql.join(
        FILING_RISK_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})`);
  let resolved = 0;
  for (const w of settled.rows) {
    const next = state.nextWorkItemState(w.status as state.WorkItemState, 'auto_resolve');
    if (!next.ok) continue;
    const resolution = w.claim_status === 'voided' ? 'Claim voided' : 'Accepted by the payer';
    await tx
      .update(workItems)
      .set({ status: next.value, resolvedBy: WATCH_ACTOR, resolution, resolvedAt: now, updatedAt: now })
      .where(eq(workItems.id, w.id));
    await recordAudit(tx, {
      actor: WATCH_ACTOR,
      action: 'work_item.resolved',
      entityType: 'work_item',
      entityId: w.id,
      clientId: w.client_id,
      metadata: { resolution },
    });
    resolved++;
  }
  return { opened, resolved };
}

/* 2. Alerts from what is true now ------------------------------------------------------------------ */

async function currentAlerts(tx: Tx, ctx: Context, now: Date): Promise<Alert[]> {
  const out: Alert[] = [];
  const s = ctx.settings.events;
  const on = (e: NotifyEventType) =>
    Object.values(s[e].channels).some(Boolean) || e === 'connection_failed' || e === 'timely_filing';

  if (on('connection_failed')) {
    const rows = await tx.execute<{
      id: string;
      client_id: string;
      connection_id: string;
      client: string;
      pm: string | null;
      summary: string;
    }>(sql`
      select w.id, w.client_id, w.connection_id, cl.name as client, conn.settings->>'pmName' as pm, w.summary
      from work_items w join connections conn on conn.id = w.connection_id join clients cl on cl.id = w.client_id
      where w.type = 'sync_failure' and w.status <> 'resolved' and conn.status = 'failed'`);
    for (const r of rows.rows) {
      const pm = r.pm ?? 'PM';
      out.push({
        event: 'connection_failed',
        key: `connection_failed:${r.id}`,
        clientId: r.client_id,
        entityType: 'connection',
        entityId: r.connection_id,
        link: `/integrations/${r.connection_id}`,
        summary: `${r.client}: ${pm} connection failed`,
        detail: 'New charges and payments are not syncing',
        assigneeId: null,
        email: {
          kind: 'Connection failed',
          title: `${pm} connection failed for ${r.client}`,
          body: `${r.summary.replace(/^[^:]*:\s*/, '')} Until it is fixed, new charges, claim status and payments are not syncing. Claims already in Cleanpost are not affected.`,
          action: 'Reconnect',
        },
      });
    }
  }

  const oob = s.out_of_balance.thresholdCents ?? 0;
  if (on('out_of_balance')) {
    const rows = await tx.execute<{
      id: string;
      client_id: string;
      remittance_id: string;
      client: string;
      payer: string;
      amount: number;
      assignee_id: string | null;
    }>(sql`
      select w.id, w.client_id, w.remittance_id, cl.name as client, r.payer_name as payer, abs(w.amount_cents)::int as amount, w.assignee_id
      from work_items w join remittances r on r.id = w.remittance_id join clients cl on cl.id = w.client_id
      where w.type = 'out_of_balance' and w.status <> 'resolved' and abs(coalesce(w.amount_cents, 0)) >= ${oob}`);
    for (const r of rows.rows)
      out.push({
        event: 'out_of_balance',
        key: `out_of_balance:${r.id}`,
        clientId: r.client_id,
        entityType: 'remittance',
        entityId: r.remittance_id,
        link: `/remittances/${r.remittance_id}`,
        summary: `${r.client}: 835 from ${r.payer} does not balance`,
        detail: `Off by ${formatCents(r.amount)}`,
        assigneeId: r.assignee_id,
        email: {
          kind: 'Out of balance',
          title: `${r.client}: an 835 from ${r.payer} is out of balance`,
          body: `The remittance is off by ${formatCents(r.amount)}, so none of its payments are matched or checked until someone accepts or fixes it.`,
          action: 'Open remittance',
        },
      });
  }

  if (on('timely_filing')) {
    const by = notify.addDays(ctx.local.date, notify.TIMELY_FILING_ALERT_DAYS);
    const rows = await tx.execute<{
      id: string;
      client_id: string;
      claim_id: string;
      client: string;
      payer: string | null;
      deadline: string;
      assignee_id: string | null;
    }>(sql`
      select w.id, w.client_id, w.claim_id, cl.name as client, p.name as payer, c.filing_deadline::text as deadline, w.assignee_id
      from work_items w join claims c on c.id = w.claim_id join clients cl on cl.id = w.client_id
        left join payers p on p.id = c.payer_id
      where w.type = 'timely_filing_risk' and w.status <> 'resolved' and c.filing_deadline <= ${by}::date`);
    for (const r of rows.rows) {
      const passed = r.deadline < ctx.local.date;
      out.push({
        event: 'timely_filing',
        key: `timely_filing:${r.id}`,
        clientId: r.client_id,
        entityType: 'claim',
        entityId: r.claim_id,
        link: `/claims/${r.claim_id}`,
        summary: passed
          ? `${r.client}: a claim passed its filing limit with ${r.payer ?? 'the payer'}`
          : `${r.client}: a claim must reach ${r.payer ?? 'the payer'} by ${notify.shortDate(r.deadline)}`,
        detail: 'Timely filing',
        assigneeId: r.assignee_id,
        email: {
          kind: 'Timely filing',
          title: `${r.client}: a claim is ${passed ? 'past' : 'near'} its filing limit with ${r.payer ?? 'the payer'}`,
          body: passed
            ? `The filing limit passed on ${notify.shortDate(r.deadline)}. Send it now with proof of timely filing if you have it, or document why.`
            : `It must be accepted by the payer by ${notify.shortDate(r.deadline)}, or the payer can deny it for timely filing.`,
          action: 'Open claim',
        },
      });
    }
  }

  if (on('sla_breach')) {
    const rows = await tx.execute<{
      id: string;
      client_id: string | null;
      type: string;
      client: string | null;
      assignee_id: string | null;
    }>(sql`
      select w.id, w.client_id, w.type, cl.name as client, w.assignee_id
      from work_items w left join clients cl on cl.id = w.client_id
      where w.priority = 1 and w.status in ('open', 'assigned', 'in_progress') and w.assignee_id is not null
        and w.due_at < ${now}
        and w.type not in ('sync_failure', 'timely_filing_risk')`);
    for (const r of rows.rows) {
      const label = work.WORK_TYPE_LABEL[r.type as work.WorkItemType] ?? r.type;
      out.push({
        event: 'sla_breach',
        key: `sla_breach:${r.id}`,
        clientId: r.client_id,
        entityType: 'work_item',
        entityId: r.id,
        link: `/work?item=${r.id}`,
        summary: `${label} is past due${r.client ? `: ${r.client}` : ''}`,
        detail: 'Priority 1',
        assigneeId: r.assignee_id,
        email: {
          kind: 'Past due',
          title: `${r.client ?? 'A priority 1 item'}: ${label.toLowerCase()} is past due`,
          body: `A priority 1 ${label.toLowerCase()} item is past its due time and still open.`,
          action: 'Open item',
        },
      });
    }
  }

  const big = s.large_denial.thresholdCents ?? 0;
  if (on('large_denial')) {
    const rows = await tx.execute<{
      id: string;
      client_id: string;
      client: string;
      payer: string | null;
      amount: number;
      assignee_id: string | null;
    }>(sql`
      select w.id, w.client_id, cl.name as client, p.name as payer, w.amount_cents::int as amount, w.assignee_id
      from work_items w join clients cl on cl.id = w.client_id
        left join claims c on c.id = w.claim_id left join payers p on p.id = c.payer_id
      where w.type = 'denial' and w.status <> 'resolved' and coalesce(w.amount_cents, 0) >= ${big}`);
    for (const r of rows.rows)
      out.push({
        event: 'large_denial',
        key: `large_denial:${r.id}`,
        clientId: r.client_id,
        entityType: 'work_item',
        entityId: r.id,
        link: `/work?item=${r.id}`,
        summary: `Denial over ${formatCents(big)}: ${r.client}`,
        detail: `${r.payer ?? 'Payer'} · ${formatCents(r.amount)}`,
        assigneeId: r.assignee_id,
        email: {
          kind: 'Large denial',
          title: `${r.client}: ${r.payer ?? 'a payer'} denied ${formatCents(r.amount)}`,
          body: `A denial of ${formatCents(r.amount)} is waiting in the denial queue.`,
          action: 'Open denial',
        },
      });
  }
  return out;
}

function recipientsOf(ctx: Context, a: Alert): Member[] {
  const def = notify.EVENT_DEFS[a.event];
  const admins = ctx.members.filter((m) => m.role === 'admin');
  const assignee = a.assigneeId ? ctx.members.find((m) => m.userId === a.assigneeId) : undefined;
  const list =
    def.audience === 'admins'
      ? admins
      : def.audience === 'assignee'
        ? // An unassigned item past its SLA is on the queue as overdue; only an owner is told.
          assignee
          ? [assignee]
          : []
        : def.audience === 'assignee_admins'
          ? [...admins, ...(assignee && assignee.role !== 'admin' ? [assignee] : [])]
          : ctx.members.filter((m) => m.role !== 'viewer');
  return list.filter((m) => sees(m, a.clientId));
}

async function notifyAll(tx: Tx, tenantId: string, ctx: Context, alerts: Alert[], now: Date) {
  let notified = 0;
  const toEmail: { notificationId: string; member: Member; alert: Alert }[] = [];
  for (const a of alerts) {
    const def = notify.EVENT_DEFS[a.event];
    const setting = ctx.settings.events[a.event];
    for (const m of recipientsOf(ctx, a)) {
      const locked = notify.emailLockedFor(a.event, m.role === 'admin');
      if (!Object.values(setting.channels).some(Boolean) && !locked) continue;
      const inserted = await tx
        .insert(notifications)
        .values({
          tenantId,
          userId: m.userId,
          clientId: a.clientId,
          type: a.event,
          entityType: a.entityType,
          entityId: a.entityId,
          summary: a.summary,
          detail: a.detail,
          link: a.link,
          urgent: def.urgent,
          inApp: setting.channels.in_app,
          dedupeKey: a.key,
        })
        .onConflictDoNothing({
          target: [notifications.tenantId, notifications.userId, notifications.dedupeKey],
          where: sql`dedupe_key is not null`,
        })
        .returning({ id: notifications.id });
      if (inserted.length) notified++;
      const [row] = await tx
        .select({ id: notifications.id, emailedAt: notifications.emailedAt })
        .from(notifications)
        .where(and(eq(notifications.userId, m.userId), eq(notifications.dedupeKey, a.key)));
      if (!row) continue;
      const send = notify.shouldEmail({
        def,
        setting,
        isAdmin: m.role === 'admin',
        alertEmail: m.alertEmail,
        quiet: notify.inQuietHours(ctx.local.time, ctx.settings.quietHours),
        lastEmailedAt: row.emailedAt,
        now,
      });
      if (send) toEmail.push({ notificationId: row.id, member: m, alert: a });
    }
  }
  return { notified, toEmail };
}

/* 4. E-04 daily digest ---------------------------------------------------------------------------- */

interface DigestPlan {
  member: Member;
  input: Parameters<typeof digestEmail>[0];
}

async function planDigests(
  deps: NotifyDeps,
  tx: Tx,
  tenantId: string,
  ctx: Context,
  now: Date,
): Promise<{ plans: DigestPlan[]; checked: string[] }> {
  const plans: DigestPlan[] = [];
  const checked: string[] = [];
  const origin = deps.appUrl ? new URL(deps.appUrl).origin : '';
  const yesterday = notify.addDays(ctx.local.date, -1);
  for (const m of ctx.members) {
    if (m.role === 'viewer' || !m.digestEmail) continue;
    if (!notify.digestDue(ctx.local, m.digestTime ?? ctx.settings.digestTime, m.lastDigestOn)) continue;
    checked.push(m.userId);
    const scope = m.role === 'admin' || m.scope === 'all' ? null : m.clientIds;
    // The person's queue: items in their clients, theirs or nobody's yet, not snoozed.
    const items = await tx
      .select({ type: workItems.type, dueAt: workItems.dueAt })
      .from(workItems)
      .where(
        and(
          ne(workItems.status, 'resolved'),
          ne(workItems.status, 'snoozed'),
          or(eq(workItems.assigneeId, m.userId), isNull(workItems.assigneeId)),
          scope ? (scope.length ? inArray(workItems.clientId, scope) : sql`false`) : undefined,
          m.role === 'admin'
            ? undefined
            : sql`${workItems.type} not in ('sync_failure', 'system', 'write_off_approval')`,
        ),
      );
    const endOfDay = new Date(now.getTime() + minutesLeftToday(ctx.local.time) * 60_000);
    const overdue = items.filter((i) => i.dueAt < now).length;
    const dueToday = items.filter((i) => i.dueAt >= now && i.dueAt < endOfDay).length;
    const groupOf = (t: string) =>
      work.WORK_TYPE_GROUPS.find((g) => (g.types as readonly string[]).includes(t));
    const byType = [
      ...work.WORK_TYPE_GROUPS.map((g) => ({
        label: g.label,
        open: items.filter((i) => groupOf(i.type)?.key === g.key).length,
        url: `${origin}/work?type=${g.key}`,
      })),
      { label: 'Other', open: items.filter((i) => !groupOf(i.type)).length, url: `${origin}/work` },
    ];
    // Yesterday across the person's clients, with the reports' definitions (RP-07).
    const overview = await getOverview(
      deps.db,
      { tenantId, userId: m.userId, clients: scope ?? 'all' },
      { from: yesterday, to: yesterday },
      undefined,
      ctx.local.date,
    );
    const released = overview.kpis.inputs.released;
    const y =
      released.total || overview.kpis.collectionsCents
        ? {
            released: released.total,
            withoutReviewPct: overview.kpis.releasedWithoutReview,
            paidCents: overview.kpis.collectionsCents,
          }
        : null;
    // Alerts since the last digest whose event goes in the digest.
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const recent = await tx
      .select({ type: notifications.type, clientId: notifications.clientId })
      .from(notifications)
      .where(and(eq(notifications.userId, m.userId), sql`${notifications.createdAt} >= ${since}`));
    const alerts = alertLines(ctx, recent);
    if (!items.length && !y && !alerts.length) continue;
    plans.push({
      member: m,
      input: {
        firstName: m.name.split(' ')[0] ?? m.name,
        fullName: m.name,
        tenantName: ctx.tenantName,
        dueToday,
        overdue,
        open: items.length,
        byType,
        yesterday: y,
        alerts,
        queueUrl: `${origin}/work`,
        sentAt: now,
        timeZone: ctx.timeZone,
      },
    });
  }
  return { plans, checked };
}

const minutesLeftToday = (time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return 24 * 60 - (h * 60 + m);
};

const ALERT_NOUN: Record<NotifyEventType, [string, string]> = {
  connection_failed: ['connection failed', 'connections failed'],
  out_of_balance: ['835 out of balance', '835s out of balance'],
  timely_filing: ['claim near its filing limit', 'claims near their filing limit'],
  sla_breach: ['priority 1 item past due', 'priority 1 items past due'],
  large_denial: ['large denial', 'large denials'],
  rule_proposed: ['rule proposed', 'rules proposed'],
  client_live: ['client went live', 'clients went live'],
};

function alertLines(ctx: Context, recent: { type: string; clientId: string | null }[]): string[] {
  const lines: string[] = [];
  for (const e of notify.NOTIFY_EVENTS) {
    if (!ctx.settings.events[e].channels.digest) continue;
    const of = recent.filter((r) => r.type === e);
    if (!of.length) continue;
    const [one, many] = ALERT_NOUN[e];
    lines.push(`${of.length} ${of.length === 1 ? one : many}`);
  }
  return lines;
}

/* 5. E-06 after the first sync -------------------------------------------------------------------- */

interface LivePlan {
  clientId: string;
  to: Member[];
  input: Parameters<typeof clientLiveEmail>[0];
  alert: Alert;
}

async function planClientLive(deps: NotifyDeps, tx: Tx, ctx: Context, now: Date): Promise<LivePlan[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await tx.execute<{
    id: string;
    name: string;
    go_live_at: Date;
    onboarding: unknown;
    mode: string;
    review_until: string | null;
    threshold: number | null;
    primary_biller_id: string | null;
    backup_biller_id: string | null;
    pm: string | null;
    encounters: number;
    patients: number;
  }>(sql`
    select cl.id, cl.name, cl.go_live_at, cl.onboarding, cl.default_mode as mode, cl.review_until::text as review_until,
      cl.auto_release_threshold as threshold, cl.primary_biller_id, cl.backup_biller_id,
      (select conn.settings->>'pmName' from connections conn where conn.client_id = cl.id limit 1) as pm,
      coalesce((select sum(coalesce((r.counts->>'new')::int, 0) + coalesce((r.counts->>'changed')::int, 0)
        + coalesce((r.counts->>'unchanged')::int, 0)) from sync_runs r
        where r.client_id = cl.id and r.operation = 'pullCharges' and r.status = 'succeeded'
          and r.started_at >= cl.go_live_at), 0)::int as encounters,
      coalesce((select sum(coalesce((r.counts->>'new')::int, 0) + coalesce((r.counts->>'changed')::int, 0))
        from sync_runs r where r.client_id = cl.id and r.operation = 'pullPatientsAndCoverage'
          and r.status = 'succeeded' and r.started_at >= cl.go_live_at), 0)::int as patients
    from clients cl
    where cl.status = 'live' and cl.go_live_at >= ${since}
      and (cl.onboarding->>'liveNotifiedAt') is null
      and (exists (select 1 from sync_runs r where r.client_id = cl.id and r.operation = 'pullCharges'
          and r.status = 'succeeded' and r.started_at >= cl.go_live_at)
        -- A PM without an integration has no first sync: it is announced at once.
        or exists (select 1 from connections conn where conn.client_id = cl.id and conn.adapter_key = 'manual'))`);
  const origin = deps.appUrl ? new URL(deps.appUrl).origin : '';
  const nameOf = (id: string | null) => ctx.members.find((m) => m.userId === id)?.name ?? null;
  return rows.rows.map((c) => {
    const alert: Alert = {
      event: 'client_live',
      key: `client_live:${c.id}`,
      clientId: c.id,
      entityType: 'client',
      entityId: c.id,
      link: `/clients/${c.id}`,
      summary: `${c.name} is live`,
      detail: c.encounters || c.patients ? 'First sync completed' : 'Claims start with the first charge file',
      assigneeId: null,
      email: { kind: 'Client live', title: `${c.name} is live`, body: '', action: 'Open client' },
    };
    return {
      clientId: c.id,
      alert,
      to: ctx.members.filter(
        (m) => m.role === 'admin' || m.userId === c.primary_biller_id || m.userId === c.backup_biller_id,
      ),
      input: {
        clientName: c.name,
        pmName: c.pm ?? 'the PM',
        mode: (c.mode as 'A' | 'B' | 'C') ?? 'A',
        goLiveAt: new Date(c.go_live_at),
        reviewUntil: c.review_until,
        threshold: c.threshold,
        primaryBiller: nameOf(c.primary_biller_id),
        backupBiller: nameOf(c.backup_biller_id),
        firstSync: c.encounters || c.patients ? { encounters: c.encounters, patients: c.patients } : null,
        url: `${origin}/clients/${c.id}`,
        timeZone: ctx.timeZone,
      },
    };
  });
}

/* The sweep -------------------------------------------------------------------------------------- */

export async function sweepTenant(deps: NotifyDeps, tenantId: string, now: Date): Promise<SweepResult> {
  const canEmail = Boolean(deps.mailer && deps.appUrl);
  const origin = deps.appUrl ? new URL(deps.appUrl).origin : '';
  const planned = await withTenant(deps.db, { tenantId }, async (tx) => {
    const ctx = await loadContext(tx, tenantId, now);
    const watch = await timelyFilingWatch(tx, tenantId, ctx.local.date, now);
    const live = await planClientLive(deps, tx, ctx, now);
    const alerts = [...(await currentAlerts(tx, ctx, now)), ...live.map((l) => l.alert)];
    const { notified, toEmail } = await notifyAll(tx, tenantId, ctx, alerts, now);
    for (const l of live) {
      const [c] = await tx
        .select({ onboarding: clients.onboarding })
        .from(clients)
        .where(eq(clients.id, l.clientId));
      await tx
        .update(clients)
        .set({ onboarding: { ...readOnboarding(c?.onboarding), liveNotifiedAt: now.toISOString() } })
        .where(eq(clients.id, l.clientId));
    }
    const digests = canEmail ? await planDigests(deps, tx, tenantId, ctx, now) : { plans: [], checked: [] };
    return { ctx, watch, live, notified, toEmail, digests };
  });
  const { ctx } = planned;

  // Emails go after the transaction; a failure is logged with its code and tried again next sweep.
  let alertEmails = 0;
  let liveEmails = 0;
  let digests = 0;
  if (canEmail) {
    const sent: string[] = [];
    for (const e of planned.toEmail) {
      try {
        await deps.mailer!.send(
          e.member.email,
          'E-05',
          alertEmail({
            kind: e.alert.email.kind,
            title: e.alert.email.title,
            body: e.alert.email.body,
            action: { label: e.alert.email.action, url: `${origin}${e.alert.link}` },
            reason:
              e.member.role === 'admin'
                ? `You get this because you're an admin for ${ctx.tenantName}.`
                : `You get this because the item is yours in ${ctx.tenantName}.`,
          }),
        );
        sent.push(e.notificationId);
        alertEmails++;
      } catch (err) {
        deps.log.warn(
          { template: 'E-05', code: (err as { code?: string }).code ?? 'unknown' },
          'alert email failed',
        );
      }
    }
    for (const l of planned.live)
      for (const m of l.to) {
        try {
          await deps.mailer!.send(m.email, 'E-06', clientLiveEmail(l.input));
          liveEmails++;
        } catch (err) {
          deps.log.warn(
            { template: 'E-06', code: (err as { code?: string }).code ?? 'unknown' },
            'client live email failed',
          );
        }
      }
    const done: string[] = [];
    for (const d of planned.digests.plans) {
      try {
        await deps.mailer!.send(d.member.email, 'E-04', digestEmail(d.input));
        digests++;
        done.push(d.member.userId);
      } catch (err) {
        deps.log.warn(
          { template: 'E-04', code: (err as { code?: string }).code ?? 'unknown' },
          'digest email failed',
        );
      }
    }
    // Checked with nothing to say counts as done for today, as does a digest that went.
    const skipped = planned.digests.checked.filter(
      (id) => !planned.digests.plans.some((p) => p.member.userId === id),
    );
    await withTenant(deps.db, { tenantId }, async (tx) => {
      if (sent.length)
        await tx.update(notifications).set({ emailedAt: now }).where(inArray(notifications.id, sent));
      for (const userId of [...done, ...skipped])
        await tx
          .insert(userPreferences)
          .values({ tenantId, userId, lastDigestOn: ctx.local.date })
          .onConflictDoUpdate({
            target: [userPreferences.tenantId, userPreferences.userId],
            set: { lastDigestOn: ctx.local.date },
          });
    });
  }

  return {
    itemsOpened: planned.watch.opened,
    itemsResolved: planned.watch.resolved,
    notified: planned.notified,
    alertEmails,
    digests,
    liveEmails,
  };
}

export { ACTOR as NOTIFY_ACTOR };
