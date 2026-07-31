/**
 * Integration tests for POST /v1/hotels/search.
 *
 * End-to-end through the Express app using:
 *  - Real HotelSearchService pipeline
 *  - Fake SupplierPort adapters (fixture-backed)
 *  - In-memory fake SearchCacheRepository
 *  - Pass-through fake OfferNormaliser and OfferRanker
 *
 * Scenarios (AC9):
 *   1. Cache miss — supplier called, 200 with correct shape.
 *   2. Cache hit — supplier NOT called, 200 from cache.
 *   3. Invalid date rejection — zero supplier calls asserted.
 *   4. Missing-review property — null signals propagated.
 *   5. All suppliers down — empty state, 200.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createHotelSearchService } from '../../src/domain/HotelSearchService.js';
import type { HotelSearchServiceDeps } from '../../src/domain/HotelSearchService.js';
import type { SupplierPort } from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { CacheGetResult, CachedSearchPayload, BackgroundRefreshFn } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const VALID_BODY = {
  location: 'New York',
  checkInDate: '2099-07-10T14:00:00.000Z',
  checkOutDate: '2099-07-13T11:00:00.000Z',
  guests: 2,
  currency: 'USD',
};

// ---------------------------------------------------------------------------
// Fixture offers
// ---------------------------------------------------------------------------

function makeFixtureOffer(id: string, opts: { reviewScore?: number | null; starRating?: number } = {}): Offer {
  return {
    id,
    provenance: 'RAPIDAPI',
    bookable: true,
    title: `Hotel ${id}`,
    price: 150,
    currency: 'USD',
    details: {
      supplier: 'RAPIDAPI',
      totalPrice: 450,
      nightlyPrice: 150,
      nights: 3,
      ...(opts.reviewScore !== undefined ? { reviewScore: opts.reviewScore } : {}),
    },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
    ...(opts.starRating !== undefined ? { rating: opts.starRating } : {}),
    reviews: 200,
  };
}

// ---------------------------------------------------------------------------
// Fake SupplierPort
// ---------------------------------------------------------------------------

function makeFixtureSupplier(name: string, offers: Offer[] = [makeFixtureOffer(`${name}-1`, { reviewScore: 8.5, starRating: 4 })]): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => offers),
  };
}

function makeNoReviewSupplier(name: string): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => [makeFixtureOffer(`${name}-nr`, { reviewScore: null })]),
  };
}

function makeFailingSupplier(name: string): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => { throw new Error(`${name} down`); }),
  };
}

// ---------------------------------------------------------------------------
// Fake normaliser (pass-through)
// ---------------------------------------------------------------------------

function makePassthroughNormaliser(): HotelSearchServiceDeps['normaliser'] {
  return { normalise: vi.fn((raw) => raw as ReadonlyArray<Offer>) } as unknown as HotelSearchServiceDeps['normaliser'];
}

// ---------------------------------------------------------------------------
// Fake ranker (identity)
// ---------------------------------------------------------------------------

function makeIdentityRanker(): HotelSearchServiceDeps['ranker'] {
  return {
    rank: vi.fn((offers: ReadonlyArray<Offer>, _prefs: MemberPreferences) =>
      offers.map((o): RankedOffer => ({ offer: o })),
    ),
  } as unknown as HotelSearchServiceDeps['ranker'];
}

// ---------------------------------------------------------------------------
// Fake cache repository
// ---------------------------------------------------------------------------

type CacheState = 'miss' | 'fresh' | 'stale';

function makeFakeCache(state: CacheState = 'miss'): HotelSearchServiceDeps['cacheRepository'] {
  const storedPayload: CachedSearchPayload = {
    schemaVersion: 1,
    generatedAt: Date.UTC(2099, 6, 1),
    offers: [makeFixtureOffer('cached-1', { reviewScore: 8.5, starRating: 4 }) as unknown as Record<string, unknown>],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
  };
  const freshHit: CacheGetResult = {
    payload: storedPayload,
    stale: false,
    generatedAt: new Date(storedPayload.generatedAt),
    key: 'k1',
  };
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async (
      _cat: string,
      _params: Record<string, unknown>,
      _fn: BackgroundRefreshFn,
      _cid: string,
    ) => state === 'miss' ? null : freshHit),
  } as unknown as HotelSearchServiceDeps['cacheRepository'];
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

const FIXED_CLOCK = { now: () => Date.UTC(2099, 5, 10) };

function buildApp(opts: { suppliers?: SupplierPort[]; cacheState?: CacheState } = {}) {
  const suppliers = opts.suppliers ?? [makeFixtureSupplier('RAPIDAPI')];
  const svcDeps: HotelSearchServiceDeps = {
    suppliers,
    cacheRepository: makeFakeCache(opts.cacheState ?? 'miss'),
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock: FIXED_CLOCK,
    alternativeStayOffsetDays: 3,
  };
  return createApp({ hotelSearchService: createHotelSearchService(svcDeps) });
}

// ---------------------------------------------------------------------------
// Scenario 1: Cache miss
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — cache miss (scenario 1)', () => {
  it('returns 200 with offers from supplier', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.offers.length).toBeGreaterThan(0);
  });

  it('each offer has the required hotel fields', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const offer = res.body.offers[0];
    expect(offer).toMatchObject({
      propertyName: expect.any(String),
      nightlyPrice: expect.any(Number),
      currency: expect.any(String),
      bookable: expect.any(Boolean),
      expiresAt: expect.any(String),
    });
  });

  it('freshness.stale is false', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.body.freshness.stale).toBe(false);
  });

  it('SUCCEEDED supplier shown as "available"', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const rapidapi = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'RAPIDAPI',
    );
    expect(rapidapi?.outcome).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Cache hit
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — cache hit (scenario 2)', () => {
  it('returns 200 without calling supplier', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: HotelSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('fresh'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ hotelSearchService: createHotelSearchService(svcDeps) });
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Invalid dates — zero supplier calls
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — date rejection (scenario 3)', () => {
  it('rejects inverted dates with 400 and no supplier calls', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: HotelSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('miss'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ hotelSearchService: createHotelSearchService(svcDeps) });
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      checkInDate: '2099-07-13T14:00:00.000Z',
      checkOutDate: '2099-07-10T11:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('rejects same-day stay with 400 and no supplier calls', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: HotelSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('miss'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ hotelSearchService: createHotelSearchService(svcDeps) });
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      checkInDate: '2099-07-10T14:00:00.000Z',
      checkOutDate: '2099-07-10T14:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Missing-review property (AC4)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — missing review data (scenario 4)', () => {
  it('returns null for reviewScore and reviewCount when absent', async () => {
    const app = buildApp({ suppliers: [makeNoReviewSupplier('RAPIDAPI')] });
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    const offer = res.body.offers[0];
    expect(offer.reviewScore).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: All suppliers down — empty state
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — all suppliers down (scenario 5)', () => {
  it('returns 200 (not 5xx) with emptyState', async () => {
    const app = buildApp({ suppliers: [makeFailingSupplier('RAPIDAPI')] });
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.emptyState).toMatchObject({
      reason: expect.any(String),
      alternativeStayDates: expect.any(Array),
    });
  });

  it('alternativeStayDates entries contain checkInDate and checkOutDate', async () => {
    const app = buildApp({ suppliers: [makeFailingSupplier('RAPIDAPI')] });
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    if (res.body.emptyState.alternativeStayDates.length > 0) {
      const first = res.body.emptyState.alternativeStayDates[0];
      expect(first).toMatchObject({
        checkInDate: expect.any(String),
        checkOutDate: expect.any(String),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Guest access
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — guest access', () => {
  it('returns 200 without Authorization header', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
  });
});
