/**
 * Notifications (G-04, S-09, E-04, E-05; docs/13 "Notifications"): which events reach whom, by which
 * channel, and when an email may go. Pure: the sweep in packages/notify applies it.
 *
 * Channels: in-app (G-04), an email right away (E-05) and the daily digest (E-04). Emails never carry
 * PHI: client names, payer names, counts and amounts only, and a link into the app.
 */
import { z } from 'zod';

export const NOTIFY_EVENTS = [
  'connection_failed',
  'out_of_balance',
  'timely_filing',
  'sla_breach',
  'large_denial',
  'rule_proposed',
  'client_live',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type Channel = 'in_app' | 'email' | 'digest';
export type Audience = 'admins' | 'assignee' | 'assignee_admins' | 'everyone';

export interface EventDef {
  event: NotifyEvent;
  label: string;
  /** S-09's "Who". */
  audience: Audience;
  audienceLabel: string;
  defaults: Record<Channel, boolean>;
  /** An amount the event must reach (S-09 edits it), in cents. */
  thresholdCents?: number;
  thresholdLabel?: string;
  /** Admins always get this email; neither S-09 nor their own profile turns it off (S-09 rules). */
  adminEmailLocked?: boolean;
  /** Sent during quiet hours too (E-05: timely filing). */
  ignoresQuietHours?: boolean;
  /** Shown as urgent in G-04's Urgent filter. */
  urgent: boolean;
}

export const EVENT_DEFS: Record<NotifyEvent, EventDef> = {
  connection_failed: {
    event: 'connection_failed',
    label: 'Connection failed',
    audience: 'admins',
    audienceLabel: 'Admins',
    defaults: { in_app: true, email: true, digest: true },
    adminEmailLocked: true,
    urgent: true,
  },
  out_of_balance: {
    event: 'out_of_balance',
    label: 'Remittance out of balance',
    audience: 'admins',
    audienceLabel: 'Admins',
    defaults: { in_app: true, email: true, digest: true },
    thresholdCents: 50_000,
    thresholdLabel: 'over',
    urgent: true,
  },
  timely_filing: {
    event: 'timely_filing',
    label: 'Timely filing within 3 days',
    audience: 'assignee_admins',
    audienceLabel: 'Assignee and admins',
    defaults: { in_app: true, email: true, digest: true },
    adminEmailLocked: true,
    ignoresQuietHours: true,
    urgent: true,
  },
  sla_breach: {
    event: 'sla_breach',
    label: 'Priority 1 item past SLA',
    audience: 'assignee',
    audienceLabel: 'Assignee',
    defaults: { in_app: true, email: false, digest: true },
    urgent: true,
  },
  large_denial: {
    event: 'large_denial',
    label: 'Denial',
    audience: 'assignee_admins',
    audienceLabel: 'Assignee and admins',
    defaults: { in_app: true, email: false, digest: true },
    thresholdCents: 100_000,
    thresholdLabel: 'over',
    urgent: false,
  },
  rule_proposed: {
    event: 'rule_proposed',
    label: 'Rule proposed from corrections',
    audience: 'admins',
    audienceLabel: 'Admins',
    defaults: { in_app: true, email: false, digest: true },
    urgent: false,
  },
  client_live: {
    event: 'client_live',
    label: 'Client go-live complete',
    audience: 'everyone',
    audienceLabel: 'Everyone on the client',
    defaults: { in_app: true, email: false, digest: false },
    urgent: false,
  },
};

/** Days before a claim's filing limit that it becomes a work item (docs/08) and an urgent alert (S-09). */
export const TIMELY_FILING_ITEM_DAYS = 14;
export const TIMELY_FILING_ALERT_DAYS = 3;
/** E-05: an unresolved alert emails again at most this often. */
export const ALERT_REPEAT_HOURS = 4;

export interface EventSetting {
  event: NotifyEvent;
  channels: Record<Channel, boolean>;
  thresholdCents: number | null;
}

export interface CompanyNotifySettings {
  events: Record<NotifyEvent, EventSetting>;
  /** "HH:MM" in the company's time zone. */
  digestTime: string;
  /** Emails wait while the local time is in [start, end); may wrap past midnight. */
  quietHours: { start: string; end: string } | null;
}

export const DEFAULT_DIGEST_TIME = '07:30';
export const DEFAULT_QUIET_HOURS = { start: '20:00', end: '07:00' } as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const storedSchema = z
  .object({
    digestTime: hhmm.optional(),
    quietHours: z.object({ start: hhmm, end: hhmm }).nullable().optional(),
  })
  .partial();

/** A rule row as stored (`notification_rules`): only events a company changed have one. */
export interface StoredRule {
  eventType: string;
  channels: readonly string[];
  thresholdCents: number | null;
  enabled: boolean;
}

/** S-09's effective settings: the defaults, the company's rule rows, its digest time and quiet hours. */
export function companySettings(
  rules: readonly StoredRule[],
  tenantSettings: unknown,
): CompanyNotifySettings {
  const raw =
    tenantSettings && typeof tenantSettings === 'object'
      ? (tenantSettings as { notifications?: unknown }).notifications
      : undefined;
  const stored = storedSchema.safeParse(raw ?? {});
  const s = stored.success ? stored.data : {};
  const events = Object.fromEntries(
    NOTIFY_EVENTS.map((e) => {
      const def = EVENT_DEFS[e];
      const row = rules.find((r) => r.eventType === e);
      const channels: Record<Channel, boolean> = row
        ? {
            in_app: row.enabled && row.channels.includes('in_app'),
            email: row.enabled && row.channels.includes('email'),
            digest: row.enabled && row.channels.includes('digest'),
          }
        : { ...def.defaults };
      return [
        e,
        {
          event: e,
          channels,
          thresholdCents:
            def.thresholdCents === undefined ? null : (row?.thresholdCents ?? def.thresholdCents),
        },
      ];
    }),
  ) as Record<NotifyEvent, EventSetting>;
  return {
    events,
    digestTime: s.digestTime ?? DEFAULT_DIGEST_TIME,
    quietHours: s.quietHours === undefined ? { ...DEFAULT_QUIET_HOURS } : s.quietHours,
  };
}

/** S-09 save input: channels and thresholds per event, digest time and quiet hours. */
export const settingsInputSchema = z.object({
  events: z
    .array(
      z.object({
        event: z.enum(NOTIFY_EVENTS),
        in_app: z.boolean(),
        email: z.boolean(),
        digest: z.boolean(),
        thresholdCents: z.number().int().min(0).max(100_000_000).nullable(),
      }),
    )
    .max(NOTIFY_EVENTS.length),
  digestTime: hhmm,
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable(),
});
export type SettingsInput = z.infer<typeof settingsInputSchema>;

/** The local date ("YYYY-MM-DD") and time ("HH:MM") of an instant in a time zone. */
export function localNow(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function inQuietHours(time: string, quiet: { start: string; end: string } | null): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? time >= quiet.start && time < quiet.end
    : time >= quiet.start || time < quiet.end;
}

/** E-04 goes once a day, at or after the digest time. */
export function digestDue(local: { date: string; time: string }, digestTime: string, lastOn: string | null) {
  return local.time >= digestTime && (!lastOn || lastOn < local.date);
}

export interface EmailDecisionInput {
  def: EventDef;
  setting: EventSetting;
  isAdmin: boolean;
  /** The person's own switch (A-09). */
  alertEmail: boolean;
  quiet: boolean;
  lastEmailedAt: Date | null;
  now: Date;
}

/** E-05: send now? Channel on (or locked for admins), not muted, outside quiet hours, not repeated within 4 hours. */
export function shouldEmail(i: EmailDecisionInput): boolean {
  const locked = Boolean(i.def.adminEmailLocked && i.isAdmin);
  if (!locked && !(i.setting.channels.email && i.alertEmail)) return false;
  if (i.quiet && !i.def.ignoresQuietHours) return false;
  return !i.lastEmailedAt || i.now.getTime() - i.lastEmailedAt.getTime() >= ALERT_REPEAT_HOURS * 3_600_000;
}

/** S-09 and A-09: whether a channel can be switched off (admins' connection and timely filing email cannot). */
export const emailLockedFor = (event: NotifyEvent, isAdmin: boolean) =>
  Boolean(EVENT_DEFS[event].adminEmailLocked && isAdmin);

/** Plain-language "Nov 8" for alert text. */
export function shortDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${ymd}T12:00:00Z`),
  );
}

export const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
