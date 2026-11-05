import { scanForPhi } from '@cleanpost/testing';
import { describe, expect, it } from 'vitest';
import { clientLiveEmail, formatTime, inviteEmail, newSignInEmail, passwordResetEmail } from '../src';

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
});
