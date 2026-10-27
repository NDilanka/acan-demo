export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * The seam for rate limiting. The pipeline calls check() once per request, keyed by client address.
 * A real limiter only has to implement this interface and be passed to createApp().
 */
export interface RateLimiter {
  check(key: string): RateDecision;
}

/** Stub: allows every request. Replace with a window or token bucket later. */
export function createNoopLimiter(): RateLimiter {
  return {
    check: () => ({ allowed: true, retryAfterSeconds: 0 }),
  };
}
