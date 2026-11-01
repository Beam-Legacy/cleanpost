/** In-memory token buckets per account and endpoint, the way a real PM enforces its limits. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Takes a token; returns 0 when allowed, otherwise the milliseconds until one is available. */
  take(key: string, perSecond: number): number {
    const capacity = Math.max(1, perSecond);
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t };
    const tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * perSecond);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: t });
      return 0;
    }
    this.buckets.set(key, { tokens, at: t });
    return Math.ceil(((1 - tokens) / perSecond) * 1000);
  }
}
