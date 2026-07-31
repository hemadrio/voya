/**
 * Integration test: Redis cache-outage degradation path.
 *
 * Uses FailingRedis and FakeClock inline implementations (no cross-package
 * test-only imports) to simulate a Redis outage via the real SearchCacheRepository.
 *
 * Verifies (AC1, AC3, AC8):
 *  - Flights endpoint returns HTTP 200 when Redis is unavailable
 *  - Response includes cacheAvailable: false during outage
 *  - Supplier-backed offers are present (never empty due to cache failure)
 *  - search_cache_unavailable_total increments
 *  - cacheAvailable: true returns when Redis is working
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createFlightSearchService } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchServiceDeps } from '../../src/domain/FlightSearchService.js';
import {
  SearchCacheRepository,
  DEFAULT_CACHE_CONFIG,
  SpyCacheMetrics,
} from '@travel/search-cache';
import type {
  SearchCacheRedisClient,
  CacheClock,
} from '@travel/search-cache';
import type { SupplierPort } from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { MemberPreferences, RankedOffer } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Inline test doubles (not exported from @travel/search-cache public API)
// ---------------------------------------------------------------------------

class InlineFailingRedis implements SearchCacheRedisClient {
  getCalls = 0;
  setexCalls = 0;
  private readonly _err = Object.assign(new Error('ECONNREFUSED 127.0.0.1:6379'), { name: 'RedisConnectionError' });

  async get(_k: string): Promise<string | null> { this.getCalls++; throw this._err; }
  async setex(_k: string, _s: number, _v: string): Promise<'OK'> { this.setexCalls++; throw this._err; }
  async setNxPx(_k: string, _v: string, _ms: number): Promise<boolean> { throw this._err; }
  async del(_k: string): Promise<number> { throw this._err; }
  async pttl(_k: string): Promise<number> { throw this._err; }
}

class InWorkingRedis implements SearchCacheRedisClient {
  private _store = new Map<string, { value: string; expiresAt: number }>();
  constructor(private _clock: CacheClock) {}

  async get(key: string): Promise<string | null> {
    const e = this._store.get(key);
    if (!e || this._clock.now() >= e.expiresAt) return null;
    return e.value;
  }
  async setex(key: string, s: number, v: string): Promise<'OK'> {
    this._store.set(key, { value: v, expiresAt: this._clock.now() + s * 1000 });
    return 'OK';
  }
  async setNxPx(key: string, v: string, ms: number): Promise<boolean> {
    const e = this._store.get(key);
    if (e && this._clock.now() < e.expiresAt) return false;
    this._store.set(key, { value: v, expiresAt: this._clock.now() + ms });
    return true;
  }
  async del(key: string): Promise<number> { return this._store.delete(key) ? 1 : 0; }
  async pttl(key: string): Promise<number> {
    const e = this._store.get(key);
    if (!e) return -2;
    const r = e.expiresAt - this._clock.now();
    return r > 0 ? r : -2;
  }
}

class InlineFakeClock implements CacheClock {
  constructor(private _now = 0) {}
  now() { return this._now; }
  advance(ms: number) { this._now += ms; }
}

// ---------------------------------------------------------------------------
// Request fixture
// ---------------------------------------------------------------------------

const VALID_BODY = {
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: '2099-06-15T12:00:00.000Z',
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

function makeOffer(id: string): Offer {
  return {
    id,
    provenance: 'RAPIDAPI',
    bookable: true,
    title: `Flight ${id}`,
    price: 299,
    currency: 'USD',
    details: { cabinClass: 'ECONOMY', supplier: 'RAPIDAPI' },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
  };
}

function makeFixtureSupplier(): SupplierPort {
  return {
    supplierName: 'RAPIDAPI',
    supportedFlows: ['INSTANT'],
    searchOffers: async () => [makeOffer('offer-degraded-1')],
  };
}

function makePassthroughNormaliser(): FlightSearchServiceDeps['normaliser'] {
  return {
    normalise: (raw: ReadonlyArray<unknown>) => raw as ReadonlyArray<Offer>,
  } as unknown as FlightSearchServiceDeps['normaliser'];
}

function makeIdentityRanker(): FlightSearchServiceDeps['ranker'] {
  return {
    rank: (offers: ReadonlyArray<Offer>, _p: MemberPreferences) =>
      offers.map((o): RankedOffer => ({ offer: o })),
  } as unknown as FlightSearchServiceDeps['ranker'];
}

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function buildDegradedApp(metrics: SpyCacheMetrics, failThreshold = 1) {
  const clock = new InlineFakeClock(Date.UTC(2099, 5, 10));
  const repo = new SearchCacheRepository({
    redis: new InlineFailingRedis(),
    clock,
    config: DEFAULT_CACHE_CONFIG,
    metrics,
    healthConfig: { consecutiveFailuresToDegrade: failThreshold, recoveryProbeIntervalMs: 30_000 },
  });
  const flightSearchService = createFlightSearchService({
    suppliers: [makeFixtureSupplier()],
    cacheRepository: repo,
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock,
    supplierTimeout: { healthyMs: 2200, degradedMs: 1500 },
  });
  return createApp({ flightSearchService });
}

function buildHealthyApp(metrics: SpyCacheMetrics) {
  const clock = new InlineFakeClock(Date.UTC(2099, 5, 10));
  const repo = new SearchCacheRepository({
    redis: new InWorkingRedis(clock),
    clock,
    config: DEFAULT_CACHE_CONFIG,
    metrics,
  });
  const flightSearchService = createFlightSearchService({
    suppliers: [makeFixtureSupplier()],
    cacheRepository: repo,
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock,
  });
  return createApp({ flightSearchService });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cache-outage degradation — flights (AC1, AC8)', () => {
  let metrics: SpyCacheMetrics;
  beforeEach(() => { metrics = new SpyCacheMetrics(); });

  it('returns HTTP 200 when Redis is unavailable — never 500', async () => {
    const app = buildDegradedApp(metrics);
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it('response includes cacheAvailable: false during Redis outage', async () => {
    const app = buildDegradedApp(metrics);
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);
    expect(res.body.cacheAvailable).toBe(false);
  });

  it('supplier-backed offers are present despite Redis failure', async () => {
    const app = buildDegradedApp(metrics);
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBeGreaterThan(0);
  });

  it('increments search_cache_unavailable_total on Redis failure (AC3)', async () => {
    // Use a high failure threshold so health state doesn't prematurely skip Redis
    const app = buildDegradedApp(metrics, 999);
    await request(app).post('/v1/flights/search').send(VALID_BODY);
    expect(metrics.unavailable.length).toBeGreaterThan(0);
  });
});

describe('Cache healthy — flights returns cacheAvailable: true (AC8)', () => {
  it('returns cacheAvailable: true when Redis is working', async () => {
    const metrics = new SpyCacheMetrics();
    const app = buildHealthyApp(metrics);
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.cacheAvailable).toBe(true);
  });
});
