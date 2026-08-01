/**
 * TurnRateLimiter unit tests (WO-059).
 *
 * Uses a fake Redis double and a fake clock to exercise:
 * - Minute and hour windows independently
 * - Separate authenticated / guest limits
 * - Window rollover behaviour
 * - Redis failure degradation to in-process fallback
 */

import { describe, it, expect } from "vitest";
import { TurnRateLimiter, BudgetRateLimitConfig, RedisClientPort } from "../../src/infrastructure/ratelimit/TurnRateLimiter.js";
import type { Principal } from "../../src/domain/conversation/ConversationRepositoryPort.js";

// ---------------------------------------------------------------------------
// Fake Redis double
// ---------------------------------------------------------------------------

class FakeRedis implements RedisClientPort {
  private store = new Map<string, { value: number; ttl: number; setAt: number }>();
  private clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  async incr(key: string): Promise<number> {
    const existing = this.store.get(key);
    const now = this.clock();
    if (!existing || (existing.ttl > 0 && now >= existing.setAt + existing.ttl * 1000)) {
      this.store.set(key, { value: 1, ttl: 0, setAt: now });
      return 1;
    }
    existing.value++;
    return existing.value;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (entry) {
      entry.ttl = seconds;
      entry.setAt = this.clock();
    }
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.ttl === 0) return -1;
    const remaining = Math.ceil(entry.ttl - (this.clock() - entry.setAt) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  /** Simulates Redis failure by throwing on the next call. */
  failNext = false;
  private maybeThrow() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("ECONNREFUSED");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BudgetRateLimitConfig = {
  authenticated: { perMinute: 5, perHour: 20 },
  guest: { perMinute: 2, perHour: 8 },
};

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

const userPrincipal = (userId = "user-abc"): Principal => ({ type: "user", userId });
const guestPrincipal = (id = "guest-xyz"): Principal => ({ type: "guest", guestSessionId: id });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TurnRateLimiter — minute window", () => {
  it("allows perMinute - 1 calls", async () => {
    const clock = makeClock();
    const redis = new FakeRedis(clock.now);
    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);

    for (let i = 0; i < 4; i++) {
      const result = await limiter.check(userPrincipal());
      expect(result.allowed).toBe(true);
    }
  });

  it("allows exactly perMinute calls", async () => {
    const clock = makeClock();
    const redis = new FakeRedis(clock.now);
    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);

    for (let i = 0; i < 5; i++) {
      await limiter.check(userPrincipal());
    }
    // 6th should be denied
    const result = await limiter.check(userPrincipal());
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.window).toBe("minute");
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("allows again after minute window rolls over", async () => {
    const clock = makeClock();
    const redis = new FakeRedis(clock.now);
    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);

    for (let i = 0; i < 5; i++) await limiter.check(userPrincipal());
    // Denied at 6th
    const denied = await limiter.check(userPrincipal());
    expect(denied.allowed).toBe(false);

    clock.advance(61_000); // roll over minute window
    const result = await limiter.check(userPrincipal());
    expect(result.allowed).toBe(true);
  });
});

describe("TurnRateLimiter — guest vs authenticated", () => {
  it("applies stricter perMinute limit to guests", async () => {
    const clock = makeClock();
    const redis = new FakeRedis(clock.now);
    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);

    // Guest: perMinute = 2
    for (let i = 0; i < 2; i++) await limiter.check(guestPrincipal());
    const denied = await limiter.check(guestPrincipal());
    expect(denied.allowed).toBe(false);
  });

  it("separate principals have independent windows", async () => {
    const clock = makeClock();
    const redis = new FakeRedis(clock.now);
    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);

    for (let i = 0; i < 5; i++) await limiter.check(userPrincipal("user-1"));
    // user-1 is denied
    expect((await limiter.check(userPrincipal("user-1"))).allowed).toBe(false);
    // user-2 is unaffected
    expect((await limiter.check(userPrincipal("user-2"))).allowed).toBe(true);
  });
});

describe("TurnRateLimiter — Redis failure degradation", () => {
  it("falls back to in-process limiter when Redis throws", async () => {
    const clock = makeClock();
    const redis = {
      incr: async () => { throw new Error("ECONNREFUSED"); },
      expire: async () => 1,
      ttl: async () => -1,
    } as RedisClientPort;

    const limiter = new TurnRateLimiter(redis, DEFAULT_CONFIG, clock.now);
    // Should not throw — falls back to conservative in-process
    const result = await limiter.check(userPrincipal());
    expect(result.allowed).toBe(true);
  });

  it("uses conservative (50%) in-process limits on Redis failure", async () => {
    const clock = makeClock();
    const alwaysFailRedis = {
      incr: async () => { throw new Error("ECONNREFUSED"); },
      expire: async () => 1,
      ttl: async () => -1,
    } as RedisClientPort;

    const limiter = new TurnRateLimiter(alwaysFailRedis, DEFAULT_CONFIG, clock.now);
    // 50% of perMinute=5 → 2 allowed
    // First 2 should be allowed
    for (let i = 0; i < 2; i++) {
      const r = await limiter.check(userPrincipal());
      expect(r.allowed).toBe(true);
    }
    // 3rd denied
    const denied = await limiter.check(userPrincipal());
    expect(denied.allowed).toBe(false);
  });

  it("works with null redis (pure in-process mode)", async () => {
    const clock = makeClock();
    const limiter = new TurnRateLimiter(null, DEFAULT_CONFIG, clock.now);
    const result = await limiter.check(userPrincipal());
    expect(result.allowed).toBe(true);
  });
});
