import { scanForPhi } from '@cleanpost/testing';
import { describe, expect, it } from 'vitest';
import {
  alertEmail,
  clientLiveEmail,
  digestEmail,
  formatTime,
  inviteEmail,
  newSignInEmail,
  passwordResetEmail,
} from '../src';

const tz = 'America/Los_Angeles';

describe('auth emails', () => {
  it('E-01 invite matches the design copy', () => {
    const e = inviteEmail({
      inviterName: 'Priya Shah',
      tenantName: 'Northwind Billing',
      role: 'biller',
      clientCount: 4,
      url: 'https://app.cleanpost.test/invite?token=abc',
      expiresAt: new Date('2026-11-05T20:00:00Z'),
      timeZone: tz,
    });
    expect(e.subject).toBe('Priya Shah invited you to Northwind Billing on Cleanpost');
    expect(e.preview).toBe('Join as a biller. The link expires in 7 days.');
    expect(e.text).toContain('as a biller for 4 clients.');
    expect(e.text).toContain('This link expires on Nov 5, 2026 and works once.');
    expect(e.html).toContain('href="https://app.cleanpost.test/invite?token=abc"');
  });

  it('E-02 password reset states the request time in the design format', () => {
    const e = passwordResetEmail({
      url: 'https://app.cleanpost.test/reset-password?token=x',
      requestedAt: new Date('2026-10-29T21:14:00Z'),
      timeZone: tz,
    });
    expect(e.text).toContain('on Oct 29, 2026 at 2:14 pm PT.');
  });

  it('E-03 new sign-in lists device, location and time', () => {
    const e = newSignInEmail({
      device: 'Chrome on macOS',
      location: 'Portland, OR',
      at: new Date('2026-10-29T15:02:00Z'),
      timeZone: tz,
      notMeUrl: 'https://app.cleanpost.test/account/security',
    });
    expect(e.preview).toBe('Chrome on macOS, near Portland, OR.');
    expect(e.text).toContain('Location: Near Portland, OR (approximate)');
    expect(e.text).toContain('Time: Oct 29, 2026, 8:02 am PT');
  });

  it('escapes HTML in every interpolated value', () => {
    const e = inviteEmail({
      inviterName: '<script>x</script>',
      tenantName: 'A & B',
      role: 'admin',
      clientCount: null,
      url: 'https://x.test/"onmouseover="',
      expiresAt: new Date(),
      timeZone: tz,
    });
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('A &amp; B');
    expect(e.html).toContain('&quot;onmouseover=&quot;');
  });

  it('contains no synthetic patient identifiers', () => {
    const all = [
      inviteEmail({
        inviterName: 'Priya Shah',
        tenantName: 'Northwind Billing',
        role: 'admin',
        clientCount: null,
        url: 'u',
        expiresAt: new Date(),
        timeZone: tz,
      }),
      passwordResetEmail({ url: 'u', requestedAt: new Date(), timeZone: tz }),
    ];
    // Workforce names like the inviter are allowed; patient names never appear in templates.
    for (const e of all) expect(scanForPhi(e.text).filter((f) => f.kind !== 'synthetic_name')).toEqual([]);
  });

  it('formats morning and evening times', () => {
    expect(formatTime(new Date('2026-10-29T16:05:00Z'), tz)).toBe('9:05 am PT');
    expect(formatTime(new Date('2026-07-01T01:30:00Z'), tz)).toBe('6:30 pm PT');
  });

  it('E-06 client live: PM, mode, billers and the review-everything date; no counts yet', () => {
    const e = clientLiveEmail({
      clientName: 'Harbor Dermatology',
      pmName: 'Tebra',
      mode: 'A',
      goLiveAt: new Date('2026-10-30T22:02:00Z'),
      reviewUntil: '2026-11-13',
      threshold: 90,
      primaryBiller: 'Marcus Lee',
      backupBiller: 'Dana Reyes',
      url: 'https://app.cleanpost.test/clients/x',
      timeZone: tz,
    });
    expect(e.subject).toBe('Harbor Dermatology is live on Cleanpost');
    expect(e.preview).toBe('Billers review every claim until Nov 13, 2026.');
    expect(e.text).toContain('on Oct 30, 2026 at 3:02 pm PT');
    expect(e.text).toContain('Marcus Lee (primary), Dana Reyes (backup)');
    expect(e.text).toContain('until Nov 13, 2026');
    const auto = clientLiveEmail({
      clientName: 'Harbor Dermatology',
      pmName: 'Tebra',
      mode: 'A',
      goLiveAt: new Date('2026-10-30T22:02:00Z'),
      reviewUntil: null,
      threshold: 85,
      primaryBiller: null,
      backupBiller: null,
      url: 'u',
      timeZone: tz,
    });
    expect(auto.preview).toContain('85');
    expect(auto.text).not.toContain('Billers');
  });

  it('E-06 after the first sync carries its counts', () => {
    const e = clientLiveEmail({
      clientName: 'Harbor Dermatology',
      pmName: 'Tebra',
      mode: 'A',
      goLiveAt: new Date('2026-10-30T22:02:00Z'),
      reviewUntil: null,
      threshold: 90,
      primaryBiller: null,
      backupBiller: null,
      firstSync: { encounters: 214, patients: 61 },
      url: 'u',
      timeZone: tz,
    });
    expect(e.text).toContain('First sync: 214 encounters, 61 patients updated');
    expect(e.text).not.toContain('running now');
  });
});

describe('notification emails', () => {
  it('E-04 digest: queue counts with links, yesterday, alerts; counts only', () => {
    const e = digestEmail({
      firstName: 'Dana',
      fullName: 'Dana Reyes',
      tenantName: 'Northwind Billing',
      dueToday: 18,
      overdue: 3,
      open: 23,
      byType: [
        { label: 'Claim review', open: 9, url: 'https://app.cleanpost.test/work?type=review' },
        { label: 'Eligibility', open: 0, url: 'https://app.cleanpost.test/work?type=eligibility' },
      ],
      yesterday: { released: 1204, withoutReviewPct: 71, paidCents: 11_248_036 },
      alerts: ['1 connection failed (Lakeside Family Medicine)'],
      queueUrl: 'https://app.cleanpost.test/work',
      sentAt: new Date('2026-11-05T15:30:00Z'),
      timeZone: tz,
    });
    expect(e.subject).toBe('Your Cleanpost queue: 18 due today, 3 overdue');
    expect(e.preview).toBe(
      'Yesterday: 1,204 claims released (71% without review) and $112,480.36 in payments.',
    );
    expect(e.text).toContain('Due today: 18');
    expect(e.text).toContain('Claim review: 9 (https://app.cleanpost.test/work?type=review)');
    expect(e.text).not.toContain('Eligibility');
    expect(e.text).toContain('Since yesterday: 1 connection failed (Lakeside Family Medicine).');
    expect(e.text).toContain('Sent at 7:30 am PT.');
    expect(e.html).toContain('href="https://app.cleanpost.test/work?type=review"');
    expect(scanForPhi(e.text).filter((f) => f.kind !== 'synthetic_name')).toEqual([]);
  });

  it('E-05 urgent alert: the client in the subject, one link', () => {
    const e = alertEmail({
      kind: 'Connection failed',
      title: 'Lakeside Family Medicine: Tebra connection failed',
      body: 'Tebra refused the saved sign-in. New charges, claim status and payments are not syncing. Claims already in Cleanpost are not affected.',
      action: { label: 'Reconnect', url: 'https://app.cleanpost.test/integrations/x' },
      reason: "You get this because you're an admin for Northwind Billing.",
    });
    expect(e.subject).toBe('Action needed: Lakeside Family Medicine: Tebra connection failed');
    expect(e.preview).toBe('Tebra refused the saved sign-in.');
    expect(e.text.split('\n')[0]).toBe('Connection failed');
    expect(e.html).toContain('href="https://app.cleanpost.test/integrations/x"');
    expect(scanForPhi(e.text).filter((f) => f.kind !== 'synthetic_name')).toEqual([]);
  });
});
