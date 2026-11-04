/**
 * The release threshold (S-04, docs/06): a claim with no blocking findings goes out without review
 * when its confidence meets the effective threshold. Effective: the client-payer override, else the
 * client's own number, else the company default (`tenants.settings.autoReleaseThreshold`), else 90.
 * 100 means "Review everything": nothing is released without a person, whatever the score.
 */
export const DEFAULT_RELEASE_THRESHOLD = 90;
export const REVIEW_EVERYTHING = 100;

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100;

/** The company default from tenant settings, or 90. */
export function companyReleaseThreshold(settings: unknown): number {
  const v = (settings as { autoReleaseThreshold?: unknown } | null)?.autoReleaseThreshold;
  return valid(v) ? v : DEFAULT_RELEASE_THRESHOLD;
}

export function effectiveReleaseThreshold(t: {
  clientPayer?: number | null;
  client?: number | null;
  company: number;
  /** CL-03 / O-09: review everything through this date (YYYY-MM-DD, the client's calendar). */
  reviewUntil?: string | null;
  /** Today in the client's calendar, YYYY-MM-DD. */
  today?: string;
}): number {
  if (t.reviewUntil && t.today && t.today <= t.reviewUntil) return REVIEW_EVERYTHING;
  return t.clientPayer ?? t.client ?? t.company;
}

/** Whether a score goes out without review at this threshold (never at 100). */
export const releasesWithoutReview = (confidence: number, threshold: number) =>
  threshold < REVIEW_EVERYTHING && confidence >= threshold;

/**
 * S-04 simulation: of last month's scrubbed claims, the share that would have gone out without
 * review at this threshold. `scores` holds, per confidence 0..100, how many claims had no blocking
 * finding; `total` counts every scrubbed claim, blocked ones included.
 */
export function simulateRelease(scores: readonly number[], total: number, threshold: number): number | null {
  if (total === 0) return null;
  if (threshold >= REVIEW_EVERYTHING) return 0;
  let n = 0;
  for (let c = Math.max(0, threshold); c <= 100; c++) n += scores[c] ?? 0;
  return n / total;
}
