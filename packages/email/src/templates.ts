/**
 * Auth emails E-01 to E-03 (ui/outputs.html). Emails never contain PHI (docs/13-cx-onboarding.md):
 * only workforce names, company names, devices and links.
 */
import { renderEmail, type EmailContent } from './layout';

/** Formats as in docs/10-design-system.md: "Oct 29, 2026" and "2:14 pm PT". */
export function formatDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(d);
}

export function formatTime(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).formatToParts(d);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  const zone = get('timeZoneName').replace(/^(P|M|C|E)[SD]T$/, '$1T');
  return `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()} ${zone}`;
}

export type Role = 'admin' | 'biller' | 'viewer';
const article = (role: Role) => (role === 'admin' ? 'an admin' : role === 'biller' ? 'a biller' : 'a viewer');

export interface InviteEmailInput {
  inviterName: string;
  tenantName: string;
  role: Role;
  /** null = all clients */
  clientCount: number | null;
  url: string;
  expiresAt: Date;
  timeZone: string;
}

/** E-01 Invite */
export function inviteEmail(i: InviteEmailInput): EmailContent {
  const scope =
    i.clientCount === null
      ? 'for all clients'
      : `for ${i.clientCount} client${i.clientCount === 1 ? '' : 's'}`;
  return renderEmail({
    subject: `${i.inviterName} invited you to ${i.tenantName} on Cleanpost`,
    preview: `Join as ${article(i.role)}. The link expires in 7 days.`,
    heading: `Join ${i.tenantName} on Cleanpost`,
    paragraphs: [
      `${i.inviterName} invited you to work in ${i.tenantName}'s Cleanpost workspace as ${article(i.role)} ${scope}.`,
    ],
    cta: { label: 'Accept invite', url: i.url },
    afterCta: [
      `You'll set a password and two-factor sign-in. This link expires on ${formatDate(i.expiresAt, i.timeZone)} and works once.`,
    ],
    reason: `You received this because ${i.inviterName} entered your email address.`,
    footerLinks: false,
  });
}

export interface PasswordResetEmailInput {
  url: string;
  requestedAt: Date;
  timeZone: string;
}

/** E-02 Password reset */
export function passwordResetEmail(i: PasswordResetEmailInput): EmailContent {
  return renderEmail({
    subject: 'Reset your Cleanpost password',
    preview: 'This link expires in 30 minutes.',
    heading: 'Reset your password',
    paragraphs: [
      `Someone asked to reset the password for this email on ${formatDate(i.requestedAt, i.timeZone)} at ${formatTime(i.requestedAt, i.timeZone)}.`,
    ],
    cta: { label: 'Reset password', url: i.url },
    afterCta: [
      "The link expires in 30 minutes. If you didn't ask for this, ignore this email; your password stays the same.",
    ],
    reason: 'You received this because a password reset was requested for your account.',
  });
}

export interface NewSignInEmailInput {
  device: string;
  location: string | null;
  at: Date;
  timeZone: string;
  notMeUrl: string;
}

/** E-03 New sign-in alert */
export function newSignInEmail(i: NewSignInEmailInput): EmailContent {
  return renderEmail({
    subject: 'New sign-in to your Cleanpost account',
    preview: i.location ? `${i.device}, near ${i.location}.` : `${i.device}.`,
    heading: 'New sign-in to your account',
    paragraphs: [],
    details: [
      ['Device', i.device],
      ['Location', i.location ? `Near ${i.location} (approximate)` : 'Unknown'],
      ['Time', `${formatDate(i.at, i.timeZone)}, ${formatTime(i.at, i.timeZone)}`],
    ],
    notes: ["If this was you, you don't need to do anything."],
    cta: { label: 'This wasn’t me', url: i.notMeUrl },
    reason: "Security alerts can't be turned off.",
  });
}

export interface AccountLockedEmailInput {
  until: Date;
  timeZone: string;
  resetUrl: string;
}

/** A-08: sent when repeated failed sign-ins lock the account (E-03 style). */
export function accountLockedEmail(i: AccountLockedEmailInput): EmailContent {
  return renderEmail({
    subject: 'Your Cleanpost account is locked for 15 minutes',
    preview: 'Too many incorrect passwords.',
    heading: 'Account locked for 15 minutes',
    paragraphs: [
      `Someone entered an incorrect password for this account 5 times. Sign-in is paused until ${formatTime(i.until, i.timeZone)}.`,
    ],
    notes: ["If this wasn't you, reset your password now."],
    cta: { label: 'Reset password', url: i.resetUrl },
    reason: "Security alerts can't be turned off.",
  });
}

export interface ClientLiveEmailInput {
  clientName: string;
  pmName: string;
  mode: 'A' | 'B' | 'C';
  goLiveAt: Date;
  /** YYYY-MM-DD in the client's calendar; null when claims can go out automatically from day one. */
  reviewUntil: string | null;
  threshold: number | null;
  primaryBiller: string | null;
  backupBiller: string | null;
  /** The first sync's counts, once it finished (the notification sweep sends E-06 then). */
  firstSync?: { encounters: number; patients: number } | null;
  url: string;
  timeZone: string;
}

const MODE_LINE = {
  A: 'Mode A: the PM sends claims, Cleanpost checks them first',
  B: 'Mode B: Cleanpost sends claims and posts payments',
  C: 'Mode C: Cleanpost sends claims, the PM posts payments',
} as const;

/**
 * E-06 Client live: sent to the company's admins and the client's billers at Go live. Names, counts
 * and dates only. The first sync is still running when it goes, so its counts are on O-11 and CL-02.
 */
export function clientLiveEmail(i: ClientLiveEmailInput): EmailContent {
  const until = i.reviewUntil ? formatDate(new Date(`${i.reviewUntil}T12:00:00Z`), 'UTC') : null;
  const billers = [
    i.primaryBiller && `${i.primaryBiller} (primary)`,
    i.backupBiller && `${i.backupBiller} (backup)`,
  ].filter((x): x is string => Boolean(x));
  return renderEmail({
    subject: `${i.clientName} is live on Cleanpost`,
    preview: until
      ? `Billers review every claim until ${until}.`
      : `Claims at or above ${i.threshold ?? 'the company'} confidence go out without review.`,
    heading: `${i.clientName} is live`,
    paragraphs: [
      `Cleanpost started working ${i.clientName}'s claims on ${formatDate(i.goLiveAt, i.timeZone)} at ${formatTime(i.goLiveAt, i.timeZone)}.${i.firstSync ? '' : ` The first sync with ${i.pmName} is running now.`}`,
    ],
    details: [
      ['PM', i.pmName],
      ['Mode', MODE_LINE[i.mode]],
      ...(i.firstSync
        ? ([
            [
              'First sync',
              `${count(i.firstSync.encounters, 'encounter')}, ${count(i.firstSync.patients, 'patient')} updated`,
            ],
          ] as [string, string][])
        : []),
      ...(billers.length ? ([['Billers', billers.join(', ')]] as [string, string][]) : []),
    ],
    notes: [
      until
        ? `This week: every claim comes to the queue for review until ${until}. After that, you can raise the release threshold from the client's settings.`
        : `Claims scoring ${i.threshold ?? 'at the company threshold'} or higher go out without review; the rest wait in the queue.`,
    ],
    cta: { label: 'Open client', url: i.url },
    reason: `You received this because you are an admin or a biller for ${i.clientName}.`,
  });
}

const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export interface DigestEmailInput {
  firstName: string;
  fullName: string;
  tenantName: string;
  dueToday: number;
  overdue: number;
  open: number;
  /** Open items by kind, each with a link to the queue filtered to it. */
  byType: { label: string; open: number; url: string }[];
  /** Yesterday across the person's clients; null when nothing happened. */
  yesterday: { released: number; withoutReviewPct: number | null; paidCents: number } | null;
  /** Alerts since the last digest, by kind ("2 denials over $1,000"). */
  alerts: string[];
  queueUrl: string;
  sentAt: Date;
  timeZone: string;
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * E-04 Daily digest: the person's queue (counts by kind, due today, overdue), yesterday across
 * their clients, and alerts since the last digest. Counts, client names and totals only.
 */
export function digestEmail(i: DigestEmailInput): EmailContent {
  const y = i.yesterday;
  const yLine = y
    ? `${count(y.released, 'claim')} released${y.withoutReviewPct !== null && y.released ? ` (${y.withoutReviewPct}% without review)` : ''} and ${dollars(y.paidCents)} in payments`
    : null;
  return renderEmail({
    subject: `Your Cleanpost queue: ${i.dueToday} due today, ${i.overdue} overdue`,
    preview: yLine ? `Yesterday: ${yLine}.` : `${count(i.open, 'item')} open in your queue.`,
    heading: `Good morning, ${i.firstName}`,
    stats: [
      ['Due today', i.dueToday.toLocaleString('en-US')],
      ['Overdue', i.overdue.toLocaleString('en-US')],
      ['Open', i.open.toLocaleString('en-US')],
    ],
    paragraphs: [],
    details: i.byType.filter((t) => t.open > 0).map((t) => [t.label, t.open.toLocaleString('en-US'), t.url]),
    notes: [
      ...(yLine ? [`Yesterday across your clients: ${yLine}.`] : []),
      ...(i.alerts.length ? [`Since yesterday: ${i.alerts.join('; ')}.`] : []),
    ],
    cta: { label: 'Open work queue', url: i.queueUrl },
    reason: `Daily digest for ${i.fullName}, ${i.tenantName}. Sent at ${formatTime(i.sentAt, i.timeZone)}.`,
  });
}

export interface AlertEmailInput {
  /** "Connection failed" */
  kind: string;
  /** "Lakeside Family Medicine: Tebra connection failed" (client names, never a patient). */
  title: string;
  body: string;
  action: { label: string; url: string };
  reason: string;
}

/** E-05 Urgent alert: what stopped and one link to fix it. No PHI; the subject names the client. */
export function alertEmail(i: AlertEmailInput): EmailContent {
  return renderEmail({
    subject: `Action needed: ${i.title}`,
    preview: i.body.split('. ')[0]!.replace(/\.$/, '') + '.',
    eyebrow: i.kind,
    heading: i.title,
    paragraphs: [i.body],
    cta: i.action,
    afterCta: [i.reason],
    reason: 'Urgent alerts go to admins and the assigned biller.',
  });
}
