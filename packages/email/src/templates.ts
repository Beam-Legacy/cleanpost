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
