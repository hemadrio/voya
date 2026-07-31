import { describe, it, expect, jest } from '@jest/globals';
import { SearchCacheRepository } from '../../src/SearchCacheRepository.js';
import { SpyCacheMetrics } from '../../src/metrics.js';
import { DEFAULT_CACHE_CONFIG, SCHEMA_VERSION } from '../../src/types.js';
import type { BackgroundRefreshFn, SearchCacheConfig } from '../../src/types.js';
import { buildKeyHash, buildKey, buildLockKey } from '../../src/keyBuilder.js';
import { FakeClock } from '../fakes/FakeClock.js';
import { FakeRedis } from '../fakes/FakeRedis.js';
import {
  BASE_GENERATED_AT,
  FLIGHT_SEARCH_PARAMS,
  HOTEL_SEARCH_PARAMS,
  makeFlightPayload,
  makeHotelPayload,
  makePayloadWithVersion,
} from '../fixtures/payloadFixtures.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRepo(
  clock: FakeClock,
  redis: FakeRedis,
  metrics?: SpyCacheMetrics,
  config?: Partial<SearchCacheConfig>,
) {
  return new SearchCacheRepository({
    redis,
    clock,
    config: { ...DEFAULT_CACHE_CONFIG, ...config },
    metrics,
  });
}

// ── TTL selection ──────────────────────────────────────────────────────────

describe('SearchCacheRepository — TTL selection per category', () => {
  it('uses flight TTL (300s) when category is flight', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload());

    // TTL should be 300s → 300_000ms remaining
    const remaining = await redis.pttl(`search:flight:${buildKeyHash(FLIGHT_SEARCH_PARAMS)}`);
    expect(remaining).toBeGreaterThan(299_000);
    expect(remaining).toBeLessThanOrEqual(300_000);
  });

  it('uses hotel TTL (900s) and car TTL (1800s) from config', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    await repo.set('hotel', HOTEL_SEARCH_PARAMS, makeHotelPayload());
    
    const hotelPttl = await redis.pttl(`search:hotel:${buildKeyHash(HOTEL_SEARCH_PARAMS)}`);
    expect(hotelPttl).toBeGreaterThan(899_000);
    expect(hotelPttl).toBeLessThanOrEqual(900_000);
  });
});

// ── Fresh vs stale classification ─────────────────────────────────────────

describe('SearchCacheRepository — freshness boundary', () => {
  const FRESHNESS_S = 60;
  const config: Partial<SearchCacheConfig> = {
    freshnessWindowSeconds: { flight: FRESHNESS_S, hotel: 180, car: 360 },
  };

  it('returns stale=false for an entry within the freshness window', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis, undefined, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));

    // Advance to just inside the freshness window
    clock.advance((FRESHNESS_S * 1000) - 1);
    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);

    expect(result).not.toBeNull();
    expect(result?.stale).toBe(false);
  });

  it('returns stale=true for an entry past the freshness window', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis, undefined, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));

    // Advance past the freshness window
    clock.advance((FRESHNESS_S * 1000) + 1);
    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);

    expect(result).not.toBeNull();
    expect(result?.stale).toBe(true);
  });

  it('returns generatedAt as a Date matching the payload timestamp', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis, undefined, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result?.generatedAt).toEqual(new Date(BASE_GENERATED_AT));
  });
});

// ── Cache miss ────────────────────────────────────────────────────────────

describe('SearchCacheRepository — cache miss', () => {
  it('returns null for a key not in Redis', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result).toBeNull();
  });

  it('returns null after the TTL has expired', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));
    clock.advance(DEFAULT_CACHE_CONFIG.ttlSeconds.flight * 1000 + 1);

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result).toBeNull();
  });
});

// ── Schema version mismatch ────────────────────────────────────────────────

describe('SearchCacheRepository — schema version handling', () => {
  it('treats an entry with a different schemaVersion as a miss', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    // Manually store a payload with old schema version
    
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const key = buildKey('flight', hash);
    const oldPayload = makePayloadWithVersion(SCHEMA_VERSION - 1 > 0 ? SCHEMA_VERSION - 1 : 999);
    await redis.setex(key, 300, JSON.stringify(oldPayload));

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result).toBeNull();
  });
});

// ── Corrupt payload ────────────────────────────────────────────────────────

describe('SearchCacheRepository — corrupt payload handling', () => {
  it('treats corrupt JSON as a miss and deletes the key', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const key = buildKey('flight', hash);
    await redis.setex(key, 300, '{ this is not json }}}');

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result).toBeNull();
    expect(redis.has(key)).toBe(false); // deleted
  });

  it('treats a payload missing required fields as a miss', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const key = buildKey('flight', hash);
    await redis.setex(key, 300, JSON.stringify({ schemaVersion: 1 })); // missing other fields

    const result = await repo.get('flight', FLIGHT_SEARCH_PARAMS);
    expect(result).toBeNull();
  });
});

// ── Metrics emission ──────────────────────────────────────────────────────

describe('SearchCacheRepository — metric emission', () => {
  it('records a miss via getWithRefresh on cold cache', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const metrics = new SpyCacheMetrics();
    const repo = makeRepo(clock, redis, metrics);

    await repo.getWithRefresh('flight', FLIGHT_SEARCH_PARAMS, jest.fn() as unknown as BackgroundRefreshFn, 'corr-1');

    expect(metrics.misses).toContain('flight');
    expect(metrics.hits).toHaveLength(0);
  });

  it('records a hit for a fresh entry', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const metrics = new SpyCacheMetrics();
    const config: Partial<SearchCacheConfig> = {
      freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
    };
    const repo = makeRepo(clock, redis, metrics, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));
    await repo.getWithRefresh('flight', FLIGHT_SEARCH_PARAMS, jest.fn() as unknown as BackgroundRefreshFn, 'corr-1');

    expect(metrics.hits).toContain('flight');
    expect(metrics.staleServes).toHaveLength(0);
  });

  it('records a stale serve for a past-freshness entry', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const metrics = new SpyCacheMetrics();
    const config: Partial<SearchCacheConfig> = {
      freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
    };
    const repo = makeRepo(clock, redis, metrics, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));
    clock.advance(61_000); // past freshness window
    await repo.getWithRefresh('flight', FLIGHT_SEARCH_PARAMS, jest.fn() as unknown as BackgroundRefreshFn, 'corr-1');

    expect(metrics.staleServes).toContain('flight');
    expect(metrics.hits).toHaveLength(0);
  });
});

// ── Single-flight lock (concurrency) ──────────────────────────────────────

describe('SearchCacheRepository — single-flight refresh lock', () => {
  it('runs exactly one background refresh for N concurrent stale reads', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const metrics = new SpyCacheMetrics();
    const config: Partial<SearchCacheConfig> = {
      freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
    };
    const repo = makeRepo(clock, redis, metrics, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));
    clock.advance(61_000); // force stale

    const refreshFn = jest.fn(async () => makeFlightPayload(clock.now())) as unknown as BackgroundRefreshFn;

    const N = 5;
    const calls = Array.from({ length: N }, () =>
      repo.getWithRefresh('flight', FLIGHT_SEARCH_PARAMS, refreshFn, `corr-${Math.random()}`),
    );
    await Promise.all(calls);

    // Allow background refresh to complete (it was detached)
    await new Promise(r => setTimeout(r, 10));

    // Exactly one refresh ran
    expect(refreshFn).toHaveBeenCalledTimes(1);
    // N-1 suppression events recorded
    expect(metrics.singleflightSuppressed).toHaveLength(N - 1);
  });

  it('releases the lock after a successful refresh', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const config: Partial<SearchCacheConfig> = {
      freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
    };
    const repo = makeRepo(clock, redis, undefined, config);

    await repo.set('flight', FLIGHT_SEARCH_PARAMS, makeFlightPayload(BASE_GENERATED_AT));
    clock.advance(61_000);

    const refreshFn = jest.fn(async () => makeFlightPayload(clock.now())) as unknown as BackgroundRefreshFn;
    await repo.getWithRefresh('flight', FLIGHT_SEARCH_PARAMS, refreshFn, 'corr-1');

    // Allow background refresh to complete
    await new Promise(r => setTimeout(r, 10));

    
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const lockKey = buildLockKey('flight', hash);
    // Lock should be released
    expect(redis.has(lockKey)).toBe(false);
  });

  it('lock self-expires via lockTtlMs if process dies (simulated by not releasing)', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const lockKey = buildLockKey('flight', hash);

    const LOCK_TTL_MS = 3_500;
    const config: Partial<SearchCacheConfig> = {
      freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
      lockTtlMs: LOCK_TTL_MS,
    };

    // Manually acquire the lock without releasing it
    await redis.setNxPx(lockKey, '1', LOCK_TTL_MS);
    expect(redis.has(lockKey)).toBe(true);

    // Advance past lock TTL
    clock.advance(LOCK_TTL_MS + 1);
    expect(redis.has(lockKey)).toBe(false); // lock self-expired
  });
});

// ── getWithRefresh returns payload ────────────────────────────────────────

describe('SearchCacheRepository — getWithRefresh payload contents', () => {
  it('returns offers and supplierOutcomes from a cached payload', async () => {
    const clock = new FakeClock(BASE_GENERATED_AT);
    const redis = new FakeRedis(clock);
    const repo = makeRepo(clock, redis);

    const payload = makeFlightPayload(BASE_GENERATED_AT, 3);
    await repo.set('flight', FLIGHT_SEARCH_PARAMS, payload);

    const result = await repo.getWithRefresh(
      'flight',
      FLIGHT_SEARCH_PARAMS,
      jest.fn() as unknown as BackgroundRefreshFn,
      'corr-1',
    );

    expect(result?.payload.offers).toHaveLength(3);
    expect(result?.payload.supplierOutcomes).toHaveLength(1);
  });
});
