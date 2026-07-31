/**
 * Redis sliding-window rate limiter with atomic Lua script and in-process fallback.
 *
 * Design constraints (from WO-016):
 *   - One Redis round trip per request (Lua script does evict + count + add atomically).
 *   - Never fail open (unlimited) or fail closed (reject all) when Redis is unavailable.
 *   - Fallback: conservative in-process token bucket, alarm emitted once per interval.
 *   - Injectable clock and Redis client for deterministic unit tests.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Result returned by consume(). */
export interface ConsumeResult {
  /** Whether the request is permitted. */
  allowed: boolean;
  /** Remaining cost units in the current window after this request. */
  remaining: number;
  /** Seconds until the window resets (suitable for Retry-After header). */
  resetAfterSeconds: number;
}

/** Minimal Redis interface (duck-typed — ioredis Redis satisfies this). */
export interface RedisClient {
  eval(
    script: string,
    numkeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/** Alarm/metrics emitter (duck-typed — allows CloudWatch or logging). */
export interface RateLimitAlarm {
  /** Called once per degradation interval when Redis is unavailable. */
  onRedisUnavailable(reason: string): void;
  /** Called for each throttled request (for CloudWatch metric). */
  onThrottled(tier: string, costClass: string): void;
}

export interface RateLimiterOptions {
  /** Redis client. When absent the limiter always uses the in-process fallback. */
  redis?: RedisClient;
  /**
   * Clock function returning the current time in milliseconds.
   * Defaults to Date.now. Inject a fake for deterministic tests.
   */
  clock?: () => number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum cost units allowed per window. */
  limit: number;
  /**
   * Per-instance conservative limit used when Redis is unavailable.
   * Defaults to 10% of the normal limit (minimum 1).
   */
  fallbackLimit?: number;
  /** Alarm/metrics hook. Omit to silence. */
  alarm?: RateLimitAlarm;
  /**
   * Interval (ms) between repeated "Redis unavailable" log/alarm emissions.
   * Defaults to 60 000 (1 minute) — avoids log flooding.
   */
  degradedLogIntervalMs?: number;
}

export interface RateLimiter {
  /**
   * Attempt to consume `cost` units from the bucket keyed by `key`.
   * Returns allowed=true and decrements the counter on success.
   * Returns allowed=false without decrementing on rejection.
   */
  consume(key: string, cost: number): Promise<ConsumeResult>;
}

// ---------------------------------------------------------------------------
// Atomic Lua script (one round trip: evict → count → add → expire)
//
// KEYS[1] = rate limit key
// ARGV[1] = now (ms, integer string)
// ARGV[2] = windowMs
// ARGV[3] = limit (max cost units)
// ARGV[4] = cost (units for this request)
// ARGV[5] = unique request member ID
//
// Returns: [allowed (0|1), remaining, resetAfterSeconds]
// ---------------------------------------------------------------------------

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local reqId = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local current = tonumber(redis.call('ZCARD', key))

if current + cost > limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAfterMs = windowMs
  if #oldest >= 2 then
    local oldestScore = tonumber(oldest[2])
    resetAfterMs = math.max(oldestScore + windowMs - now, 1)
  end
  return {0, math.max(limit - current, 0), math.ceil(resetAfterMs / 1000)}
end

for i = 1, cost do
  redis.call('ZADD', key, now, reqId .. ':' .. tostring(i))
end
redis.call('PEXPIRE', key, windowMs)
return {1, limit - (current + cost), math.ceil(windowMs / 1000)}
`;

// ---------------------------------------------------------------------------
// In-process token bucket fallback (used when Redis is unavailable)
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

class InProcessFallback {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(key: string, cost: number, nowMs: number): ConsumeResult {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.limit, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }

    // Refill proportionally to elapsed time
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed > 0) {
      const refill = (elapsed / this.windowMs) * this.limit;
      bucket.tokens = Math.min(this.limit, bucket.tokens + refill);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens < cost) {
      const remaining = Math.max(0, bucket.tokens);
      const resetAfterSeconds = Math.max(
        1,
        Math.ceil(((cost - bucket.tokens) / this.limit) * (this.windowMs / 1000)),
      );
      return { allowed: false, remaining: Math.floor(remaining), resetAfterSeconds };
    }

    bucket.tokens -= cost;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetAfterSeconds: Math.ceil(this.windowMs / 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// Counter for unique member IDs — monotonically increasing, per-process
// ---------------------------------------------------------------------------
let _seq = 0;
function nextMemberId(): string {
  _seq = (_seq + 1) % 0xffffff;
  return `${process.pid ?? 0}:${_seq}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const {
    redis,
    windowMs,
    limit,
    alarm,
    degradedLogIntervalMs = 60_000,
  } = options;
  const clock = options.clock ?? (() => Date.now());
  const fallbackLimit = options.fallbackLimit ?? Math.max(1, Math.floor(limit * 0.1));
  const fallback = new InProcessFallback(fallbackLimit, windowMs);

  let degradedMode = false;
  let lastDegradedLogMs = 0;

  function enterDegradedMode(reason: string): void {
    const nowMs = clock();
    degradedMode = true;
    if (nowMs - lastDegradedLogMs >= degradedLogIntervalMs) {
      lastDegradedLogMs = nowMs;
      alarm?.onRedisUnavailable(reason);
    }
  }

  return {
    async consume(key: string, cost: number): Promise<ConsumeResult> {
      const nowMs = clock();

      if (!redis || degradedMode) {
        // Attempt to exit degraded mode on each request (Redis may have recovered)
        if (redis && degradedMode) {
          try {
            await redis.eval('return 1', 0);
            degradedMode = false;
          } catch {
            // Still unavailable
          }
        }
        if (!redis || degradedMode) {
          return fallback.consume(key, cost, nowMs);
        }
      }

      try {
        const result = await redis.eval(
          SLIDING_WINDOW_LUA,
          1,
          key,
          String(Math.floor(nowMs)),
          String(windowMs),
          String(limit),
          String(cost),
          nextMemberId(),
        );

        // Lua returns a table: {allowed, remaining, resetAfterSeconds}
        if (!Array.isArray(result) || result.length < 3) {
          throw new Error('Unexpected Lua response shape');
        }
        const [rawAllowed, rawRemaining, rawReset] = result as [unknown, unknown, unknown];
        const allowed = Number(rawAllowed) === 1;
        const remaining = Number(rawRemaining);
        const resetAfterSeconds = Number(rawReset);
        return { allowed, remaining, resetAfterSeconds };
      } catch (err) {
        enterDegradedMode(String(err));
        return fallback.consume(key, cost, nowMs);
      }
    },
  };
}
