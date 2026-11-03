import { afterEach, describe, expect, it } from 'vitest';
import { demoTimeAllowed, getOffset, now, nowMs, setOffset } from '../src';

const DAY = 86_400_000;
const env = process.env.CLEANPOST_ENV;

afterEach(() => {
  if (env === undefined) delete process.env.CLEANPOST_ENV;
  else process.env.CLEANPOST_ENV = env;
  setOffset(0);
});

describe('demo time', () => {
  it('moves business time by the offset', () => {
    const before = Date.now();
    setOffset(14 * DAY);
    expect(getOffset()).toBe(14 * DAY);
    expect(now().getTime() - before).toBeGreaterThanOrEqual(14 * DAY);
    expect(nowMs() - Date.now()).toBeGreaterThanOrEqual(14 * DAY - 5);
  });

  it('is refused in staging and production, where only zero is allowed', () => {
    for (const e of ['staging', 'production']) {
      process.env.CLEANPOST_ENV = e;
      expect(demoTimeAllowed()).toBe(false);
      expect(() => setOffset(DAY)).toThrow(/only available in local and preview/);
      expect(() => setOffset(0)).not.toThrow();
    }
    for (const e of ['local', 'preview', 'test']) expect(demoTimeAllowed(e)).toBe(true);
    delete process.env.CLEANPOST_ENV;
    expect(demoTimeAllowed()).toBe(true); // local by default
  });
});
