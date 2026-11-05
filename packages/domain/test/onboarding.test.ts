import { describe, expect, it } from 'vitest';
import { awaiting, goLiveChecklist, readOnboarding, spread, stepIndex, type GoLiveFacts } from '../src';

const ready: GoLiveFacts = {
  practiceComplete: true,
  renderingProviders: 1,
  locations: 1,
  connectionTested: true,
  dryRunConfirmed: true,
  unmatchedPayers: 0,
  payersSetUp: 3,
  modeChosen: true,
  postingReviewed: true,
  automationSet: true,
  primaryBiller: true,
  backupBiller: true,
  practiceInformed: true,
};

describe('onboarding (O-01 to O-10, docs/13)', () => {
  it('keeps the furthest step, defaulting to the first', () => {
    expect(readOnboarding(null)).toEqual({ step: 1 });
    expect(readOnboarding({ step: 4, modeChosen: true })).toEqual({ step: 4, modeChosen: true });
    expect(readOnboarding({ step: 40 }).step).toBe(1);
    expect(stepIndex('dry-run')).toBe(4);
  });

  it('needs every checklist item, and says which step fixes a failing one', () => {
    expect(goLiveChecklist(ready).every((i) => i.ok)).toBe(true);
    const missing = goLiveChecklist({ ...ready, unmatchedPayers: 1, backupBiller: false });
    expect(missing.filter((i) => !i.ok).map((i) => [i.key, i.fix])).toEqual([
      ['payers', 'payers'],
      ['billers', 'go-live'],
    ]);
    expect(
      goLiveChecklist({ ...ready, renderingProviders: 0 }).find((i) => i.key === 'practice'),
    ).toMatchObject({
      ok: false,
      fix: 'providers',
    });
  });
});

describe('wizard helpers', () => {
  it('spreads samples across the pull: first, last and in between', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const out = spread(xs, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(99);
    expect(new Set(out).size).toBe(10);
    expect(spread([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('waits for a result newer than the request', () => {
    expect(awaiting(undefined, undefined)).toBe(false);
    expect(awaiting('2026-11-05T10:00:00.000Z', undefined)).toBe(true);
    expect(awaiting('2026-11-05T10:00:00.000Z', '2026-11-05T09:59:00.000Z')).toBe(true);
    expect(awaiting('2026-11-05T10:00:00.000Z', '2026-11-05T10:00:05.000Z')).toBe(false);
  });
});
