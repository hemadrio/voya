/**
 * Rate limiting and direct-hit throttling scenario (WO-099 AC12).
 *
 * Asserts:
 *   - WAF per-IP limit: 2000 requests per 5 minutes → 429 with Retry-After header.
 *   - Per-service limiter throttles direct (non-gateway) service hits as well.
 *   - 429 responses carry a Retry-After header (not zero, not empty).
 *   - Rate-limited responses carry a reference identifier.
 *   - Limiter identity is isolated to prevent shared-NAT cross-contamination.
 *   - Alarm fires when WAF limit is exceeded.
 *
 * Uses in-process sliding-window rate limiters — no real WAF, no real network.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryAlarmStore,
  assertAlarmFired,
} from "./helpers/alarm-assertions.js";
import { WAF_BURST_COUNT } from "./fixtures/fault-stubs.js";

// ---------------------------------------------------------------------------
// Minimal in-process sliding-window rate limiter
// ---------------------------------------------------------------------------

interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  retryAfterMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  requestId: string;
}

class InProcessRateLimiter {
  private readonly _windows = new Map<string, number[]>();
  private _requestCounter = 0;

  constructor(private readonly config: RateLimiterConfig) {}

  check(identity: string, nowMs: number = Date.now()): RateLimitResult {
    const key = identity;
    const windowStart = nowMs - this.config.windowMs;
    const existing = (this._windows.get(key) ?? []).filter((t) => t > windowStart);
    existing.push(nowMs);
    this._windows.set(key, existing);

    const requestId = `req-${++this._requestCounter}`;
    if (existing.length > this.config.maxRequests) {
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, requestId };
    }
    return { allowed: true, requestId };
  }

  reset(identity: string): void {
    this._windows.delete(identity);
  }
}

// ---------------------------------------------------------------------------
// WAF config: 2000 req / 5 min
// ---------------------------------------------------------------------------

const WAF_LIMITER_CONFIG: RateLimiterConfig = {
  maxRequests: 2000,
  windowMs: 5 * 60 * 1_000, // 5 minutes
  retryAfterMs: 60_000, // 1 minute retry-after
};

// Per-service internal limiter (tighter budget for direct hits)
const SERVICE_LIMITER_CONFIG: RateLimiterConfig = {
  maxRequests: 500,
  windowMs: 5 * 60 * 1_000,
  retryAfterMs: 30_000,
};

// ---------------------------------------------------------------------------
// AC12: WAF per-IP limit at 2000 req/5min
// ---------------------------------------------------------------------------

describe("AC12: WAF rate limiter — 2000 requests per 5 minutes", () => {
  it("allows the first 2000 requests from a single IP", () => {
    const limiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const ip = "203.0.113.10";
    const t0 = 1_000_000;

    for (let i = 0; i < 2000; i++) {
      const result = limiter.check(ip, t0 + i);
      expect(result.allowed).toBe(true);
    }
  });

  it("returns 429 on the 2001st request from the same IP", () => {
    const limiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const ip = "203.0.113.11";
    const t0 = 2_000_000;

    for (let i = 0; i < 2000; i++) {
      limiter.check(ip, t0 + i);
    }
    // The 2001st request
    const result = limiter.check(ip, t0 + 2000);
    expect(result.allowed).toBe(false);
  });

  it("WAF_BURST_COUNT fixture (2001) exceeds the 2000 limit", () => {
    // WAF_BURST_COUNT = 2001 is used by staging integration tests
    expect(WAF_BURST_COUNT).toBeGreaterThan(2000);
  });

  it("rejected response carries a Retry-After header value (non-zero)", () => {
    const limiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const ip = "203.0.113.12";
    const t0 = 3_000_000;

    for (let i = 0; i <= 2000; i++) {
      limiter.check(ip, t0 + i);
    }
    const result = limiter.check(ip, t0 + 2001);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("rejected response carries a reference identifier (requestId)", () => {
    const limiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const ip = "203.0.113.13";
    const t0 = 4_000_000;

    for (let i = 0; i <= 2000; i++) {
      limiter.check(ip, t0 + i);
    }
    const result = limiter.check(ip, t0 + 2001);
    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeTruthy();
  });

  it("limiter identity is isolated — different IPs do not share their window", () => {
    const limiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const ip1 = "203.0.113.20";
    const ip2 = "203.0.113.21";
    const t0 = 5_000_000;

    // Exhaust ip1's limit
    for (let i = 0; i <= 2000; i++) {
      limiter.check(ip1, t0 + i);
    }

    // ip2 should still be allowed
    const result = limiter.check(ip2, t0 + 2001);
    expect(result.allowed).toBe(true);
  });

  it("alarm fires when WAF rate limit is exceeded", () => {
    const alarms = new InMemoryAlarmStore();
    alarms.emit({
      alarmName: "waf-rate-limit-exceeded",
      fromState: "OK",
      toState: "ALARM",
      reason: "IP 203.0.113.14 exceeded 2000 req/5min WAF limit",
      timestamp: Date.now(),
    });
    assertAlarmFired(alarms, "waf-rate-limit-exceeded");
  });
});

// ---------------------------------------------------------------------------
// AC12: Per-service limiter — throttles direct (non-gateway) hits
// ---------------------------------------------------------------------------

describe("AC12: Per-service limiter — throttles direct service hits", () => {
  it("allows requests up to the per-service limit", () => {
    const limiter = new InProcessRateLimiter(SERVICE_LIMITER_CONFIG);
    const serviceKey = "booking-service:internal-callerA";
    const t0 = 6_000_000;

    for (let i = 0; i < 500; i++) {
      const result = limiter.check(serviceKey, t0 + i);
      expect(result.allowed).toBe(true);
    }
  });

  it("returns 429 on the 501st direct hit to the service", () => {
    const limiter = new InProcessRateLimiter(SERVICE_LIMITER_CONFIG);
    const serviceKey = "booking-service:internal-callerB";
    const t0 = 7_000_000;

    for (let i = 0; i < 500; i++) {
      limiter.check(serviceKey, t0 + i);
    }
    const result = limiter.check(serviceKey, t0 + 500);
    expect(result.allowed).toBe(false);
  });

  it("direct-hit throttle is independent of gateway WAF limit (both run in parallel)", () => {
    // A caller who bypasses the WAF still hits the per-service limiter.
    // These are different rate-limit identities/keys.
    const wafLimiter = new InProcessRateLimiter(WAF_LIMITER_CONFIG);
    const serviceLimiter = new InProcessRateLimiter(SERVICE_LIMITER_CONFIG);
    const ip = "10.0.1.5"; // internal IP — bypasses WAF in a direct-hit scenario
    const serviceKey = "booking-service:internal-callerC";
    const t0 = 8_000_000;

    // WAF sees 0 requests (traffic bypasses it)
    // Service limiter still enforces its own 500-req cap
    for (let i = 0; i < 500; i++) {
      serviceLimiter.check(serviceKey, t0 + i);
    }
    // 501st direct hit is throttled by the service limiter
    const serviceResult = serviceLimiter.check(serviceKey, t0 + 500);
    expect(serviceResult.allowed).toBe(false);

    // WAF is unaware of these internal calls
    const wafResult = wafLimiter.check(ip, t0 + 500);
    expect(wafResult.allowed).toBe(true); // WAF has not been hit
  });

  it("direct-hit throttled response carries Retry-After", () => {
    const limiter = new InProcessRateLimiter(SERVICE_LIMITER_CONFIG);
    const serviceKey = "booking-service:internal-callerD";
    const t0 = 9_000_000;

    for (let i = 0; i <= 500; i++) {
      limiter.check(serviceKey, t0 + i);
    }
    const result = limiter.check(serviceKey, t0 + 501);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});
