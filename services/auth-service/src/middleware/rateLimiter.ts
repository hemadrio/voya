/**
 * In-memory sliding-window rate limiter for forgot-password and reset-password.
 *
 * Keyed on a combination of normalized email and client IP so both axes are
 * independently rate-limited.  The implementation is single-node; a shared
 * Redis-backed limiter would be wired here for multi-instance deployments.
 *
 * Entries older than the window are pruned on each check to bound memory usage.
 */

import { rateLimited } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Interface (injectable for testing)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns the number of seconds to retry after, or 0 if the request is allowed. */
  check(key: string): number;
  /** Record a hit for the key. */
  record(key: string): void;
}

// ---------------------------------------------------------------------------
// In-memory sliding window implementation
// ---------------------------------------------------------------------------

export interface InMemoryRateLimiterOptions {
  /** Maximum hits allowed within the window. Default: 5. */
  maxHits?: number;
  /** Window duration in seconds. Default: 900 (15 minutes). */
  windowSeconds?: number;
}

export function createInMemoryRateLimiter(opts: InMemoryRateLimiterOptions = {}): RateLimiter {
  const maxHits = opts.maxHits ?? 5;
  const windowMs = (opts.windowSeconds ?? 900) * 1000;
  const hits = new Map<string, number[]>();

  function prune(timestamps: number[], now: number): number[] {
    return timestamps.filter((t) => now - t < windowMs);
  }

  return {
    check(key: string): number {
      const now = Date.now();
      const raw = hits.get(key) ?? [];
      const recent = prune(raw, now);
      hits.set(key, recent);

      if (recent.length >= maxHits) {
        const oldest = recent[0] as number;
        const retryAfterMs = windowMs - (now - oldest);
        return Math.ceil(retryAfterMs / 1000);
      }
      return 0;
    },

    record(key: string): void {
      const now = Date.now();
      const raw = hits.get(key) ?? [];
      const recent = prune(raw, now);
      recent.push(now);
      hits.set(key, recent);
    },
  };
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Extract the rate-limit key from the request. */
  getKey(req: { headers: Record<string, string | string[] | undefined>; body?: unknown }): string;
}

export function createRateLimitMiddleware(opts: RateLimitMiddlewareOptions) {
  return function rateLimitMiddleware(
    req: { headers: Record<string, string | string[] | undefined>; body?: unknown },
    _res: unknown,
    next: (err?: unknown) => void,
  ): void {
    const key = opts.getKey(req);
    const retryAfterSeconds = opts.limiter.check(key);

    if (retryAfterSeconds > 0) {
      const err = rateLimited(`Too many requests. Try again in ${retryAfterSeconds} seconds.`);
      next(err);
      return;
    }

    opts.limiter.record(key);
    next();
  };
}
