/**
 * Unit tests for the sliding-window rate limiter.
 *
 * All tests use a fake clock and an in-memory Redis double so they are
 * deterministic and require no live Redis instance.
 */

import { createRateLimiter } from '../src/slidingWindowLimiter.js';
import { buildKey, tierFromRoles, TIER_LIMITS, COST_CLASS } from '../src/config/tiers.js';

// ---------------------------------------------------------------------------
// In-memory Redis double (sorted-set semantics only)
// ---------------------------------------------------------------------------

interface SortedSetEntry {
  score: number;
  member: string;
}

class FakeRedis {
  private readonly sets = new Map<string, SortedSetEntry[]>();
  private readonly expiresAt = new Map<string, number>();
  private _now: () => number;

  constructor(nowFn: () => number) {
    this._now = nowFn;
  }

  private getSet(key: string): SortedSetEntry[] {
    const now = this._now();
    const exp = this.expiresAt.get(key);
    if (exp !== undefined && now > exp) {
      this.sets.delete(key);
      this.expiresAt.delete(key);
    }
    return this.sets.get(key) ?? [];
  }

  private setSet(key: string, entries: SortedSetEntry[]): void {
    this.sets.set(key, entries);
  }

  async eval(_script: string, _numkeys: number, ...args: Array<string | number>): Promise<unknown> {
    // The script args are: key, now, windowMs, limit, cost, reqId
    const key = String(args[0]);
    const now = Number(args[1]);
    const windowMs = Number(args[2]);
    const limit = Number(args[3]);
    const cost = Number(args[4]);
    const reqId = String(args[5]);

    // Evict old entries
    let entries = this.getSet(key).filter((e) => e.score > now - windowMs);

    const current = entries.length;

    if (current + cost > limit) {
      const oldest = entries.length > 0 ? (entries[0]?.score ?? now) : now;
      const resetAfterMs = Math.max(oldest + windowMs - now, 1);
      return [0, Math.max(limit - current, 0), Math.ceil(resetAfterMs / 1000)];
    }

    for (let i = 1; i <= cost; i++) {
      entries.push({ score: now, member: `${reqId}:${i}` });
    }
    // Sort by score for ZRANGE compatibility
    entries.sort((a, b) => a.score - b.score);
    this.setSet(key, entries);
    this.expiresAt.set(key, now + windowMs);

    return [1, limit - (current + cost), Math.ceil(windowMs / 1000)];
  }

  /** Check current count for a key (test helper). */
  count(key: string): number {
    return this.getSet(key).length;
  }
}

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

class FakeClock {
  private _ms: number;
  constructor(initialMs = 0) {
    this._ms = initialMs;
  }
  now(): number {
    return this._ms;
  }
  advance(ms: number): void {
    this._ms += ms;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(actorOrIp = 'actor-1', costClass: keyof typeof COST_CLASS = 'cheap_read') {
  return buildKey('gw', 'traveler', actorOrIp, costClass);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRateLimiter — window boundary behaviour', () => {
  it('allows requests up to the limit', async () => {
    const clock = new FakeClock(1_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 3,
    });
    const key = makeKey();

    const r1 = await limiter.consume(key, 1);
    const r2 = await limiter.consume(key, 1);
    const r3 = await limiter.consume(key, 1);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('rejects the first request that would exceed the limit', async () => {
    const clock = new FakeClock(1_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 3,
    });
    const key = makeKey();

    await limiter.consume(key, 1);
    await limiter.consume(key, 1);
    await limiter.consume(key, 1);
    const r4 = await limiter.consume(key, 1);

    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetAfterSeconds).toBeGreaterThan(0);
  });

  it('allows requests again after the window slides', async () => {
    const clock = new FakeClock(1_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 2,
    });
    const key = makeKey();

    await limiter.consume(key, 1);
    await limiter.consume(key, 1);
    const denied = await limiter.consume(key, 1);
    expect(denied.allowed).toBe(false);

    // Advance past the window
    clock.advance(61_000);

    const r = await limiter.consume(key, 1);
    expect(r.allowed).toBe(true);
  });

  it('computes Retry-After as a positive integer', async () => {
    const clock = new FakeClock(1_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 1,
    });
    const key = makeKey();

    await limiter.consume(key, 1);
    const r = await limiter.consume(key, 1);

    expect(r.allowed).toBe(false);
    expect(Number.isInteger(r.resetAfterSeconds)).toBe(true);
    expect(r.resetAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('createRateLimiter — cost accounting', () => {
  it('deducts the full cost for an expensive request', async () => {
    const clock = new FakeClock(2_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 10,
    });
    const key = makeKey('actor-x', 'expensive');

    const r = await limiter.consume(key, COST_CLASS.expensive);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(10 - COST_CLASS.expensive);
  });

  it('rejects when remaining units are insufficient for a costly request', async () => {
    const clock = new FakeClock(2_000_000);
    const redis = new FakeRedis(clock.now.bind(clock));
    const limiter = createRateLimiter({
      redis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 4,
    });
    const key = makeKey('actor-y', 'expensive');

    // cost=5 exceeds limit=4 immediately
    const r = await limiter.consume(key, 5);
    expect(r.allowed).toBe(false);
  });
});

describe('createRateLimiter — tier resolution', () => {
  it('maps system role to system tier', () => {
    expect(tierFromRoles(['system'])).toBe('system');
  });

  it('maps support_agent role to support_agent tier', () => {
    expect(tierFromRoles(['support_agent'])).toBe('support_agent');
  });

  it('maps traveler role to traveler tier', () => {
    expect(tierFromRoles(['traveler'])).toBe('traveler');
  });

  it('maps empty/undefined roles to guest tier', () => {
    expect(tierFromRoles([])).toBe('guest');
    expect(tierFromRoles(undefined)).toBe('guest');
  });

  it('system role takes precedence over other roles', () => {
    expect(tierFromRoles(['traveler', 'system'])).toBe('system');
  });
});

describe('createRateLimiter — key derivation', () => {
  it('builds the expected key format', () => {
    const key = buildKey('gw', 'traveler', 'user-123', 'cheap_read');
    expect(key).toBe('rl:gw:traveler:user-123:cheap_read');
  });

  it('uses different scopes for gateway vs service floor', () => {
    const gwKey = buildKey('gw', 'traveler', 'actor-1', 'standard');
    const floorKey = buildKey('auth', 'traveler', 'actor-1', 'standard');
    expect(gwKey).not.toBe(floorKey);
  });
});

describe('createRateLimiter — Redis-unavailable fallback', () => {
  it('falls back to in-process bucket when Redis eval throws', async () => {
    const clock = new FakeClock(3_000_000);
    let alarmFired = false;

    const brokenRedis = {
      eval: async () => { throw new Error('ECONNREFUSED'); },
    };

    const limiter = createRateLimiter({
      redis: brokenRedis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 100,
      fallbackLimit: 10,
      alarm: {
        onRedisUnavailable: () => { alarmFired = true; },
        onThrottled: () => {},
      },
    });

    const r = await limiter.consume('fallback-key', 1);
    expect(r.allowed).toBe(true);
    expect(alarmFired).toBe(true);
  });

  it('in-process fallback denies requests over the fallback limit', async () => {
    const clock = new FakeClock(3_000_000);
    const brokenRedis = { eval: async () => { throw new Error('down'); } };

    const limiter = createRateLimiter({
      redis: brokenRedis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 100,
      fallbackLimit: 2,
    });

    const r1 = await limiter.consume('fb-key', 1);
    const r2 = await limiter.consume('fb-key', 1);
    const r3 = await limiter.consume('fb-key', 1);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
  });

  it('alarm fires at most once per degradedLogIntervalMs', async () => {
    const clock = new FakeClock(4_000_000);
    let alarmCount = 0;
    const brokenRedis = { eval: async () => { throw new Error('down'); } };

    const limiter = createRateLimiter({
      redis: brokenRedis,
      clock: clock.now.bind(clock),
      windowMs: 60_000,
      limit: 100,
      fallbackLimit: 50,
      degradedLogIntervalMs: 5000,
      alarm: {
        onRedisUnavailable: () => { alarmCount++; },
        onThrottled: () => {},
      },
    });

    await limiter.consume('key', 1); // fires alarm (first time)
    await limiter.consume('key', 1); // should NOT fire (within interval)
    clock.advance(6000);
    await limiter.consume('key', 1); // fires again (interval elapsed)

    expect(alarmCount).toBe(2);
  });
});

describe('createRateLimiter — tier limits are below WAF ceiling', () => {
  const WAF_CEILING_PER_WINDOW = 2000;

  for (const [tier, limit] of Object.entries(TIER_LIMITS)) {
    it(`${tier} limit (${limit}) is below WAF ceiling (${WAF_CEILING_PER_WINDOW})`, () => {
      expect(limit).toBeLessThan(WAF_CEILING_PER_WINDOW);
    });
  }
});
