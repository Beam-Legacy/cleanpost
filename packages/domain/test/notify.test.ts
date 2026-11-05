import { describe, expect, it } from 'vitest';
import { notify } from '../src';

const { companySettings, digestDue, EVENT_DEFS, inQuietHours, localNow, shouldEmail } = notify;

describe('notification settings (S-09)', () => {
  it('starts from the defaults and applies a company row and its stored times', () => {
    const none = companySettings([], {});
    expect(none.events.connection_failed.channels).toEqual({ in_app: true, email: true, digest: true });
    expect(none.events.large_denial.thresholdCents).toBe(100_000);
    expect(none.events.client_live.thresholdCents).toBeNull();
    expect(none.digestTime).toBe('07:30');
    expect(none.quietHours).toEqual({ start: '20:00', end: '07:00' });

    const changed = companySettings(
      [{ eventType: 'large_denial', channels: ['in_app', 'email'], thresholdCents: 250_000, enabled: true }],
      { notifications: { digestTime: '06:45', quietHours: null } },
    );
    expect(changed.events.large_denial).toMatchObject({
      channels: { in_app: true, email: true, digest: false },
      thresholdCents: 250_000,
    });
    expect(changed.digestTime).toBe('06:45');
    expect(changed.quietHours).toBeNull();
  });

  it('a disabled rule turns every channel off; bad stored times fall back to the defaults', () => {
    const s = companySettings(
      [{ eventType: 'client_live', channels: ['in_app'], thresholdCents: null, enabled: false }],
      { notifications: { digestTime: '7am' } },
    );
    expect(s.events.client_live.channels).toEqual({ in_app: false, email: false, digest: false });
    expect(s.digestTime).toBe('07:30');
  });
});

describe('timing', () => {
  it('reads the local date and time in the company time zone', () => {
    // 2026-11-05 15:10 UTC is 7:10 am in Los Angeles.
    expect(localNow(new Date('2026-11-05T15:10:00Z'), 'America/Los_Angeles')).toEqual({
      date: '2026-11-05',
      time: '07:10',
    });
  });

  it('quiet hours wrap past midnight', () => {
    const q = { start: '20:00', end: '07:00' };
    expect(inQuietHours('21:30', q)).toBe(true);
    expect(inQuietHours('06:59', q)).toBe(true);
    expect(inQuietHours('07:00', q)).toBe(false);
    expect(inQuietHours('12:00', { start: '12:00', end: '13:00' })).toBe(true);
    expect(inQuietHours('12:00', null)).toBe(false);
  });

  it('the digest goes once a day, at or after its time', () => {
    expect(digestDue({ date: '2026-11-05', time: '07:29' }, '07:30', '2026-11-04')).toBe(false);
    expect(digestDue({ date: '2026-11-05', time: '07:30' }, '07:30', '2026-11-04')).toBe(true);
    expect(digestDue({ date: '2026-11-05', time: '09:00' }, '07:30', '2026-11-05')).toBe(false);
    expect(digestDue({ date: '2026-11-05', time: '09:00' }, '07:30', null)).toBe(true);
  });
});

describe('urgent email (E-05)', () => {
  const now = new Date('2026-11-05T18:00:00Z');
  const base = (event: notify.NotifyEvent) => ({
    def: EVENT_DEFS[event],
    setting: companySettings([], {}).events[event],
    isAdmin: false,
    alertEmail: true,
    quiet: false,
    lastEmailedAt: null as Date | null,
    now,
  });

  it('goes when the channel is on, and again only after 4 hours', () => {
    expect(shouldEmail(base('out_of_balance'))).toBe(true);
    expect(
      shouldEmail({ ...base('out_of_balance'), lastEmailedAt: new Date(now.getTime() - 3_600_000) }),
    ).toBe(false);
    expect(
      shouldEmail({ ...base('out_of_balance'), lastEmailedAt: new Date(now.getTime() - 4 * 3_600_000) }),
    ).toBe(true);
  });

  it('waits for quiet hours to end, except timely filing', () => {
    expect(shouldEmail({ ...base('out_of_balance'), quiet: true })).toBe(false);
    expect(shouldEmail({ ...base('timely_filing'), quiet: true })).toBe(true);
  });

  it("respects the person's own switch, except admins' connection and timely filing emails", () => {
    expect(shouldEmail({ ...base('out_of_balance'), alertEmail: false })).toBe(false);
    expect(shouldEmail({ ...base('connection_failed'), alertEmail: false })).toBe(false);
    expect(shouldEmail({ ...base('connection_failed'), alertEmail: false, isAdmin: true })).toBe(true);
    const off = companySettings(
      [{ eventType: 'connection_failed', channels: ['in_app'], thresholdCents: null, enabled: true }],
      {},
    ).events.connection_failed;
    expect(shouldEmail({ ...base('connection_failed'), setting: off, isAdmin: true })).toBe(true);
    expect(shouldEmail({ ...base('connection_failed'), setting: off })).toBe(false);
  });

  it('events off by default for email stay quiet', () => {
    expect(shouldEmail(base('large_denial'))).toBe(false);
    expect(shouldEmail(base('client_live'))).toBe(false);
  });
});
