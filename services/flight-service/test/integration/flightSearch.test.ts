/**
 * Integration tests for POST /v1/flights/search.
 *
 * End-to-end through the Express app with:
 *  - Real FlightSearchService (full pipeline)
 *  - Fake SupplierPort adapters backed by fixture data
 *  - In-memory fake SearchCacheRepository
 *  - Pass-through fake OfferNormaliser and OfferRanker
 *
 * No live network calls. All dependencies are injectable fakes.
 *
 * Scenarios (AC9):
 *   1. Cache miss → supplier called, 200 with correct response shape.
 *   2. Cache hit (fresh) → supplier NOT called, 200 from cache.
 *   3. Partial supplier failure → attributed outcomes, 200 with offers.
 *   4. All suppliers down → empty state with alternative dates, 200.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createFlightSearchService } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchServiceDeps } from '../../src/domain/FlightSearchService.js';
import type { SearchCacheRepository } from '@travel/search-cache';
import type { CacheGetResult, CachedSearchPayload, BackgroundRefreshFn } from '@travel/search-cache';
import type { SupplierPort } from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Request body — uses full ISO-8601 datetime (required by isoDateString schema)
// ---------------------------------------------------------------------------

const VALID_BODY = {
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: '2099-06-15T12:00:00.000Z',
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

// ---------------------------------------------------------------------------
// Fixture offer — satisfies Offer type at runtime
// ---------------------------------------------------------------------------

function makeFixtureOffer(id: string): Offer {
  return {
    id,
    provenance: 'AMADEUS',
    bookable: true,
    title: `LHR-JFK Economy (fixture-${id})`,
    price: 299,
    currency: 'USD',
    details: { cabinClass: 'ECONOMY', stops: 0, supplier: 'AMADEUS' },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
  };
}

function makeRankedOffer(id: string): RankedOffer {
  return { offer: makeFixtureOffer(id) };
}

// ---------------------------------------------------------------------------
// Fake SupplierPort
// ---------------------------------------------------------------------------

function makeFixtureSupplier(
  name: string,
  offers: Offer[] = [makeFixtureOffer(`${name}-o1`)],
): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => offers),
  };
}

function makeFailingSupplier(name: string): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => {
      throw new Error(`${name} is down`);
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake OfferNormaliser (pass-through — validates nothing, just casts)
// ---------------------------------------------------------------------------

function makePassthroughNormaliser(): FlightSearchServiceDeps['normaliser'] {
  return {
    normalise: vi.fn((rawOffers: ReadonlyArray<unknown>) => rawOffers as ReadonlyArray<Offer>),
  } as unknown as FlightSearchServiceDeps['normaliser'];
}

// ---------------------------------------------------------------------------
// Fake OfferRanker (identity — preserves order, wraps in RankedOffer)
// ---------------------------------------------------------------------------

function makeIdentityRanker(): FlightSearchServiceDeps['ranker'] {
  return {
    rank: vi.fn((offers: ReadonlyArray<Offer>, _prefs: MemberPreferences) =>
      offers.map((o): RankedOffer => ({ offer: o })),
    ),
  } as unknown as FlightSearchServiceDeps['ranker'];
}

// ---------------------------------------------------------------------------
// Fake SearchCacheRepository
// ---------------------------------------------------------------------------

type FakeCacheState = 'miss' | 'fresh' | 'stale';

function makeFakeCache(state: FakeCacheState = 'miss'): FlightSearchServiceDeps['cacheRepository'] {
  const storedPayload: CachedSearchPayload = {
    schemaVersion: 1,
    generatedAt: Date.UTC(2099, 5, 10),
    offers: [makeFixtureOffer('cached-1') as unknown as Record<string, unknown>],
    supplierOutcomes: [{ supplier: 'AMADEUS', outcome: 'SUCCEEDED' }],
  };

  const freshHit: CacheGetResult = {
    payload: storedPayload,
    stale: false,
    generatedAt: new Date(storedPayload.generatedAt),
    key: 'search:flight:abc123',
  };

  const staleHit: CacheGetResult = {
    payload: storedPayload,
    stale: true,
    generatedAt: new Date(storedPayload.generatedAt),
    key: 'search:flight:abc123',
  };

  return {
    get: vi.fn(async () => state === 'miss' ? null : freshHit),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async (
      _category: string,
      _params: Record<string, unknown>,
      _refreshFn: BackgroundRefreshFn,
      _correlationId: string,
    ) => {
      if (state === 'miss') return null;
      if (state === 'fresh') return freshHit;
      return staleHit;
    }),
  } as unknown as FlightSearchServiceDeps['cacheRepository'];
}

// ---------------------------------------------------------------------------
// App builder helper
// ---------------------------------------------------------------------------

interface TestDeps {
  suppliers?: SupplierPort[];
  cacheState?: FakeCacheState;
}

const FIXED_CLOCK = { now: () => Date.UTC(2099, 5, 10) }; // June 10 2099

function buildApp(deps: TestDeps = {}) {
  const {
    suppliers = [makeFixtureSupplier('AMADEUS')],
    cacheState = 'miss',
  } = deps;

  const svcDeps: FlightSearchServiceDeps = {
    suppliers,
    cacheRepository: makeFakeCache(cacheState),
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock: FIXED_CLOCK,
    alternativeDateOffsetDays: 3,
  };

  const flightSearchService = createFlightSearchService(svcDeps);
  return createApp({ flightSearchService });
}

// ---------------------------------------------------------------------------
// Scenario 1: Cache miss — supplier called
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — cache miss (scenario 1)', () => {
  it('returns 200 with offers from the supplier', async () => {
    const app = buildApp({ cacheState: 'miss' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers.length).toBeGreaterThan(0);
  });

  it('includes freshness with stale=false', async () => {
    const app = buildApp({ cacheState: 'miss' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.freshness).toMatchObject({
      generatedAt: expect.any(String),
      stale: false,
    });
  });

  it('includes supplierOutcomes with SUCCEEDED mapped to "available"', async () => {
    const app = buildApp({ cacheState: 'miss' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(Array.isArray(res.body.supplierOutcomes)).toBe(true);
    const amadeus = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'AMADEUS',
    );
    expect(amadeus?.outcome).toBe('available');
  });

  it('each offer contains the required fields', async () => {
    const app = buildApp({ cacheState: 'miss' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const offer = res.body.offers[0];
    expect(offer).toMatchObject({
      supplier: expect.any(String),
      totalPrice: expect.any(Number),
      currency: expect.any(String),
      bookable: expect.any(Boolean),
      provenance: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('does not include emptyState on success', async () => {
    const app = buildApp({ cacheState: 'miss' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.emptyState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Cache hit (fresh) — supplier NOT called
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — cache hit fresh (scenario 2)', () => {
  it('returns 200 from cache without calling the supplier', async () => {
    const supplier = makeFixtureSupplier('AMADEUS');
    const cache = makeFakeCache('fresh');

    const flightSearchService = createFlightSearchService({
      suppliers: [supplier],
      cacheRepository: cache,
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    });

    const app = createApp({ flightSearchService });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('marks freshness.stale as false on fresh cache hit', async () => {
    const app = buildApp({ cacheState: 'fresh' });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.freshness.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Partial supplier failure — attributed outcomes
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — partial failure (scenario 3)', () => {
  it('returns 200 with offers from working supplier', async () => {
    const app = buildApp({
      suppliers: [
        makeFixtureSupplier('AMADEUS', [makeFixtureOffer('a1')]),
        makeFailingSupplier('RAPIDAPI'),
      ],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.offers.length).toBeGreaterThan(0);
  });

  it('attributes the failing supplier in supplierOutcomes', async () => {
    const app = buildApp({
      suppliers: [
        makeFixtureSupplier('AMADEUS', [makeFixtureOffer('a1')]),
        makeFailingSupplier('RAPIDAPI'),
      ],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const rapidapi = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'RAPIDAPI',
    );
    expect(rapidapi).toBeDefined();
    // Must use traveller-safe language, not internal 'FAILED'
    expect(rapidapi?.outcome).toBe('unavailable');
  });

  it('successful supplier shows as "available" in outcomes', async () => {
    const app = buildApp({
      suppliers: [
        makeFixtureSupplier('AMADEUS', [makeFixtureOffer('a1')]),
        makeFailingSupplier('RAPIDAPI'),
      ],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const amadeus = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'AMADEUS',
    );
    expect(amadeus?.outcome).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: All suppliers down — empty state
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — all suppliers down (scenario 4)', () => {
  it('returns 200 (not 4xx or 5xx) when all suppliers fail', async () => {
    const app = buildApp({
      suppliers: [makeFailingSupplier('AMADEUS'), makeFailingSupplier('RAPIDAPI')],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
  });

  it('includes emptyState.reason and emptyState.alternativeDates', async () => {
    const app = buildApp({
      suppliers: [makeFailingSupplier('AMADEUS')],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.emptyState).toMatchObject({
      reason: expect.any(String),
      alternativeDates: expect.any(Array),
    });
    expect(res.body.emptyState.alternativeDates.length).toBeGreaterThan(0);
  });

  it('alternativeDates excludes the original departure date', async () => {
    const app = buildApp({
      suppliers: [makeFailingSupplier('AMADEUS')],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const altDates: string[] = res.body.emptyState?.alternativeDates ?? [];
    expect(altDates).not.toContain('2099-06-15');
  });

  it('offers array is empty in the empty state', async () => {
    const app = buildApp({
      suppliers: [makeFailingSupplier('AMADEUS')],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.offers).toHaveLength(0);
  });

  it('all supplier outcomes show as "unavailable"', async () => {
    const app = buildApp({
      suppliers: [makeFailingSupplier('AMADEUS')],
      cacheState: 'miss',
    });
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    for (const outcome of res.body.supplierOutcomes) {
      expect((outcome as { outcome: string }).outcome).toBe('unavailable');
    }
  });
});

// ---------------------------------------------------------------------------
// Guest access — no authentication required
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — guest access', () => {
  it('returns 200 without any Authorization header', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/flights/search')
      .send(VALID_BODY); // No .set('Authorization', ...)

    expect(res.status).toBe(200);
  });
});
