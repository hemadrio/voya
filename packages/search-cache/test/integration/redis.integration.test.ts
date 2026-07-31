/**
 * Integration tests against a live Redis 7 instance.
 *
 * Requires REDIS_URL in the environment (e.g. redis://localhost:6379).
 * Skipped automatically when REDIS_URL is not set.
 *
 * Run locally:
 *   docker compose up -d redis
 *   REDIS_URL=redis://localhost:6379 npx jest --config jest.config.cjs test/integration/
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SearchCacheRepository } from '../../src/SearchCacheRepository.js';
import { DEFAULT_CACHE_CONFIG, SCHEMA_VERSION, SystemCacheClock } from '../../src/types.js';
import type { SearchCacheRedisClient } from '../../src/types.js';
import { buildKey, buildKeyHash, buildLockKey } from '../../src/keyBuilder.js';
import {
  FLIGHT_SEARCH_PARAMS,
  HOTEL_SEARCH_PARAMS,
  BASE_GENERATED_AT,
  makeFlightPayload,
  makeHotelPayload,
} from '../fixtures/payloadFixtures.js';

// ---------------------------------------------------------------------------
// Gate: skip when Redis is not available
// ---------------------------------------------------------------------------

const REDIS_URL = process.env['REDIS_URL'];
const describeWithRedis = REDIS_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// IoRedis adapter that satisfies SearchCacheRedisClient
// ---------------------------------------------------------------------------

async function buildRedisClient(url: string): Promise<{ client: SearchCacheRedisClient & { quit(): Promise<void> } }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: Redis } = await import('ioredis') as any;
  const raw = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  await raw.connect();

  const client: SearchCacheRedisClient & { quit(): Promise<void> } = {
    get: (key: string) => raw.get(key),
    setex: (key: string, seconds: number, value: string) => raw.setex(key, seconds, value),
    setNxPx: async (key: string, value: string, ms: number): Promise<boolean> => {
      const result: string | null = await raw.set(key, value, 'NX', 'PX', ms);
      return result === 'OK';
    },
    del: (key: string) => raw.del(key),
    pttl: (key: string) => raw.pttl(key),
    quit: () => raw.quit(),
  };

  return { client };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describeWithRedis('SearchCacheRepository — Redis integration', () => {
  let redisClient: SearchCacheRedisClient & { quit(): Promise<void> };
  let repo: SearchCacheRepository;
  const clock = new SystemCacheClock();

  // Key prefix used to isolate test keys from production data
  const TEST_PREFIX = `test:${Date.now()}`;

  function prefixedParams(base: Record<string, unknown>): Record<string, unknown> {
    return { ...base, _testPrefix: TEST_PREFIX };
  }

  beforeAll(async () => {
    const { client } = await buildRedisClient(REDIS_URL as string);
    redisClient = client;
    repo = new SearchCacheRepository({
      redis: redisClient,
      clock,
      config: {
        ...DEFAULT_CACHE_CONFIG,
        ttlSeconds: { flight: 2, hotel: 2, car: 2 }, // short TTL for expiry tests
        freshnessWindowSeconds: { flight: 1, hotel: 1, car: 1 },
        lockTtlMs: 500,
      },
    });
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it('set stores an entry and get retrieves it', async () => {
    const params = prefixedParams(FLIGHT_SEARCH_PARAMS);
    const payload = makeFlightPayload(clock.now());
    await repo.set('flight', params, payload);

    const result = await repo.get('flight', params);
    expect(result).not.toBeNull();
    expect(result?.payload.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result?.payload.offers).toHaveLength(2);
  });

  it('fresh get returns stale=false immediately after set', async () => {
    const params = prefixedParams({ ...FLIGHT_SEARCH_PARAMS, marker: 'fresh' });
    await repo.set('flight', params, makeFlightPayload(clock.now()));

    const result = await repo.get('flight', params);
    expect(result?.stale).toBe(false);
  });

  it('stale get returns stale=true after the freshness window elapses', async () => {
    const params = prefixedParams({ ...FLIGHT_SEARCH_PARAMS, marker: 'stale' });
    const past = clock.now() - 2_000; // 2 seconds ago — past 1s freshness window
    await repo.set('flight', params, makeFlightPayload(past));

    const result = await repo.get('flight', params);
    expect(result?.stale).toBe(true);
  });

  it('stale get via getWithRefresh triggers background refresh', async () => {
    const params = prefixedParams({ ...FLIGHT_SEARCH_PARAMS, marker: 'bg-refresh' });
    const past = clock.now() - 2_000;
    await repo.set('flight', params, makeFlightPayload(past));

    let refreshCalled = false;
    const result = await repo.getWithRefresh(
      'flight',
      params,
      async () => {
        refreshCalled = true;
        return makeFlightPayload(clock.now());
      },
      'integration-corr-1',
    );

    expect(result?.stale).toBe(true);
    // Allow background refresh to complete
    await new Promise(r => setTimeout(r, 200));
    expect(refreshCalled).toBe(true);

    // Fresh result should now be in cache
    const refreshedResult = await repo.get('flight', params);
    expect(refreshedResult?.stale).toBe(false);
  });

  it('TTL expiry: entry is absent after TTL expires (2s)', async () => {
    const params = prefixedParams({ ...HOTEL_SEARCH_PARAMS, marker: 'ttl-expiry' });
    await repo.set('hotel', params, makeHotelPayload(clock.now()));

    // Verify it is present
    const present = await repo.get('hotel', params);
    expect(present).not.toBeNull();

    // Wait for TTL (2s + buffer)
    await new Promise(r => setTimeout(r, 2_500));

    const absent = await repo.get('hotel', params);
    expect(absent).toBeNull();
  });

  it('lock self-expires after lockTtlMs (500ms)', async () => {
    const params = prefixedParams({ ...FLIGHT_SEARCH_PARAMS, marker: 'lock-expiry' });
    const hash = buildKeyHash(params);
    const lockKey = buildLockKey('flight', hash);

    // Manually acquire and hold the lock
    const acquired = await redisClient.setNxPx(lockKey, '1', 500);
    expect(acquired).toBe(true);

    // Wait for lock TTL
    await new Promise(r => setTimeout(r, 700));

    const pttl = await redisClient.pttl(lockKey);
    expect(pttl).toBe(-2); // key absent/expired
  });
});
