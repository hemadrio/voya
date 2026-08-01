/**
 * TurnRateLimiter — Redis-backed fixed-window rate limiter for assistant turns
 * (WO-059).
 *
 * Two separate limits per principal type (authenticated / guest):
 *   - perMinute: maximum turns in a rolling 60-second window
 *   - perHour:   maximum turns in a rolling 3600-second window
 *
 * Keys are keyed by principal identifier (userId or guestSessionId) — NEVER
 * by conversation ID or tenant, so labels remain low-cardinality.
 *
 * Redis failure degrades to a conservative in-process fallback counter (NOT
 * disabled entirely) and logs a warning.  The fallback resets on process
 * restart, so it is intentionally more conservative than the Redis limit.
 *
 * check() returns { allowed: true } or { allowed: false, retryAfterSeconds }.
 */

import type { Principal } from "../../domain/conversation/ConversationRepositoryPort.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WindowLimits {
  perMinute: number;
  perHour: number;
}

export interface BudgetRateLimitConfig {
  authenticated: WindowLimits;
  guest: WindowLimits;
}

// ---------------------------------------------------------------------------
// Redis duck-type — keeps domain code free of ioredis dependency
// ---------------------------------------------------------------------------

export interface RedisClientPort {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  /** Returns the TTL in seconds, or -1 if no TTL, or -2 if key missing. */
  ttl(key: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Rate-limit result
// ---------------------------------------------------------------------------

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; window: "minute" | "hour" };

// ---------------------------------------------------------------------------
// In-process fallback store
// ---------------------------------------------------------------------------

interface FallbackWindow {
  count: number;
  resetAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// TurnRateLimiter
// ---------------------------------------------------------------------------

export class TurnRateLimiter {
  /** In-process fallback: key → [minuteWindow, hourWindow] */
  private readonly fallback = new Map<string, [FallbackWindow, FallbackWindow]>();

  constructor(
    private readonly redis: RedisClientPort | null,
    private readonly config: BudgetRateLimitConfig,
    private readonly clock: () => number = () => Date.now(),
    private readonly log?: { warn(obj: Record<string, unknown>, msg: string): void },
  ) {}

  /**
   * Check whether the principal may make a new turn.
   * Increments the counter if allowed.
   */
  async check(principal: Principal): Promise<RateLimitResult> {
    const id = principal.type === "user" ? principal.userId : principal.guestSessionId;
    const limits = principal.type === "user" ? this.config.authenticated : this.config.guest;

    if (this.redis !== null) {
      return this.checkRedis(id, limits);
    }
    return this.checkFallback(id, limits);
  }

  // ---------------------------------------------------------------------------
  // Redis-backed implementation
  // ---------------------------------------------------------------------------

  private async checkRedis(id: string, limits: WindowLimits): Promise<RateLimitResult> {
    try {
      const minuteKey = `rl:turn:${id}:1m`;
      const hourKey = `rl:turn:${id}:1h`;

      // Minute window
      const minuteCount = await this.redis!.incr(minuteKey);
      if (minuteCount === 1) {
        await this.redis!.expire(minuteKey, 60);
      }
      if (minuteCount > limits.perMinute) {
        const ttl = await this.redis!.ttl(minuteKey);
        return { allowed: false, retryAfterSeconds: Math.max(ttl, 1), window: "minute" };
      }

      // Hour window
      const hourCount = await this.redis!.incr(hourKey);
      if (hourCount === 1) {
        await this.redis!.expire(hourKey, 3600);
      }
      if (hourCount > limits.perHour) {
        const ttl = await this.redis!.ttl(hourKey);
        return { allowed: false, retryAfterSeconds: Math.max(ttl, 1), window: "hour" };
      }

      return { allowed: true };
    } catch (err) {
      this.log?.warn(
        { errType: (err as Error)?.name },
        "Redis rate-limit check failed — falling back to in-process limiter",
      );
      return this.checkFallback(id, {
        perMinute: Math.floor(limits.perMinute * 0.5),
        perHour: Math.floor(limits.perHour * 0.5),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // In-process fallback (conservative — 50% of configured limits)
  // ---------------------------------------------------------------------------

  private checkFallback(id: string, limits: WindowLimits): RateLimitResult {
    const now = this.clock();
    let windows = this.fallback.get(id);
    if (!windows) {
      windows = [
        { count: 0, resetAt: now + 60_000 },
        { count: 0, resetAt: now + 3_600_000 },
      ];
      this.fallback.set(id, windows);
    }

    const [minuteWindow, hourWindow] = windows;

    if (now >= minuteWindow.resetAt) {
      minuteWindow.count = 0;
      minuteWindow.resetAt = now + 60_000;
    }
    if (now >= hourWindow.resetAt) {
      hourWindow.count = 0;
      hourWindow.resetAt = now + 3_600_000;
    }

    if (minuteWindow.count >= limits.perMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((minuteWindow.resetAt - now) / 1000),
        window: "minute",
      };
    }
    if (hourWindow.count >= limits.perHour) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((hourWindow.resetAt - now) / 1000),
        window: "hour",
      };
    }

    minuteWindow.count++;
    hourWindow.count++;
    return { allowed: true };
  }
}
