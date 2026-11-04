import { describe, expect, it } from 'vitest';
import {
  companyReleaseThreshold,
  effectiveReleaseThreshold,
  releasesWithoutReview,
  scoreClaim,
  simulateRelease,
} from '../src';

describe('release threshold (S-04, docs/06)', () => {
  it('takes the client-payer override, then the client, then the company default (90)', () => {
    expect(companyReleaseThreshold({})).toBe(90);
    expect(companyReleaseThreshold({ autoReleaseThreshold: 85 })).toBe(85);
    expect(companyReleaseThreshold({ autoReleaseThreshold: 140 })).toBe(90);
    expect(effectiveReleaseThreshold({ company: 85 })).toBe(85);
    expect(effectiveReleaseThreshold({ client: 92, company: 85 })).toBe(92);
    expect(effectiveReleaseThreshold({ clientPayer: 70, client: 92, company: 85 })).toBe(70);
  });

  it('100 means review everything, even a perfect score', () => {
    expect(releasesWithoutReview(100, 90)).toBe(true);
    expect(releasesWithoutReview(89, 90)).toBe(false);
    expect(releasesWithoutReview(100, 100)).toBe(false);
    expect(
      scoreClaim([], { threshold: 100, firstClaimForClientPayer: false, payerFirstPassRate: null }),
    ).toMatchObject({
      confidence: 100,
      decision: 'review',
    });
  });

  it('simulates the share of last month released without review at a threshold', () => {
    const scores = Array.from({ length: 101 }, () => 0);
    scores[100] = 6;
    scores[85] = 2;
    scores[70] = 2;
    // 10 not blocked, 2 blocked: 12 scrubbed.
    expect(simulateRelease(scores, 12, 90)).toBeCloseTo(6 / 12);
    expect(simulateRelease(scores, 12, 80)).toBeCloseTo(8 / 12);
    expect(simulateRelease(scores, 12, 0)).toBeCloseTo(10 / 12);
    expect(simulateRelease(scores, 12, 100)).toBe(0);
    expect(simulateRelease(scores, 0, 90)).toBeNull();
  });
});
