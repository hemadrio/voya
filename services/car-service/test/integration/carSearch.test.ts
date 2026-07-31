/**
 * Integration tests for POST /v1/cars/search.
 *
 * End-to-end through the Express app using:
 *  - Real CarSearchService pipeline
 *  - Fake SupplierPort adapters (fixture-backed)
 *  - In-memory fake SearchCacheRepository
 *  - Pass-through fake OfferNormaliser and OfferRanker
 *
 * Scenarios (AC9):
 *   1. Cache miss — supplier called, 200 with correct shape.
 *   2. Cache hit — supplier NOT called, 200 from cache.
 *   3. Inverted date-time rejection — zero supplier calls asserted.
 *   4. UNKNOWN vehicle class fixture — retained in response.
 *   5. All suppliers down — empty state, 200.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createCarSearchService } from '../../src/domain/CarSearchService.js';
import type { CarSearchServiceDeps } from '../../src/domain/CarSearchService.js';
import type { SupplierPort } from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { CacheGetResult, CachedSearchPayload, BackgroundRefreshFn } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const VALID_BODY = {
  pickupLocation: 'JFK',
  dropoffLocation: 'JFK',
  pickupDate: '2099-06-15T12:00:00.000Z',
  dropoffDate: '2099-06-18T12:00:00.000Z',
  carClass: 'ECONOMY',
  currency: 'USD',
};

// ---------------------------------------------------------------------------
// Fixture offers
// ---------------------------------------------------------------------------

function makeFixtureOffer(id: string, vehicleClass = 'ECONOMY'): Offer {
  return {
    id,
    provenance: 'RAPIDAPI',
    bookable: true,
    title: 'Toyota Yaris',
    price: 120,
    currency: 'USD',
    details: {
      supplier: 'RAPIDAPI',
      vehicleClass,
      pickupLocation: 'JFK',
      dropoffLocation: 'JFK',
      totalPrice: 120,
    },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
  };
}

// ---------------------------------------------------------------------------
// Fake SupplierPort
// ---------------------------------------------------------------------------

function makeFixtureSupplier(name: string, offers: Offer[] = [makeFixtureOffer(`${name}-1`)]): SupplierPort {
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
    searchOffers: vi.fn(async () => { throw new Error(`${name} down`); }),
  };
}

// ---------------------------------------------------------------------------
// Fake normaliser (pass-through)
// ---------------------------------------------------------------------------

function makePassthroughNormaliser(): CarSearchServiceDeps['normaliser'] {
  return { normalise: vi.fn((raw) => raw as ReadonlyArray<Offer>) } as unknown as CarSearchServiceDeps['normaliser'];
}

// ---------------------------------------------------------------------------
// Fake ranker (identity)
// ---------------------------------------------------------------------------

function makeIdentityRanker(): CarSearchServiceDeps['ranker'] {
  return {
    rank: vi.fn((offers: ReadonlyArray<Offer>, _prefs: MemberPreferences) =>
      offers.map((o): RankedOffer => ({ offer: o })),
    ),
  } as unknown as CarSearchServiceDeps['ranker'];
}

// ---------------------------------------------------------------------------
// Fake cache repository
// ---------------------------------------------------------------------------

type CacheState = 'miss' | 'fresh';

function makeFakeCache(state: CacheState = 'miss'): CarSearchServiceDeps['cacheRepository'] {
  const storedPayload: CachedSearchPayload = {
    schemaVersion: 1,
    generatedAt: Date.UTC(2099, 5, 1),
    offers: [makeFixtureOffer('cached-1') as unknown as Record<string, unknown>],
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
  } as unknown as CarSearchServiceDeps['cacheRepository'];
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

const FIXED_CLOCK = { now: () => Date.UTC(2099, 5, 10) };

function buildApp(opts: { suppliers?: SupplierPort[]; cacheState?: CacheState } = {}) {
  const suppliers = opts.suppliers ?? [makeFixtureSupplier('RAPIDAPI')];
  const svcDeps: CarSearchServiceDeps = {
    suppliers,
    cacheRepository: makeFakeCache(opts.cacheState ?? 'miss'),
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock: FIXED_CLOCK,
  };
  return createApp({ carSearchService: createCarSearchService(svcDeps) });
}

// ---------------------------------------------------------------------------
// Scenario 1: Cache miss
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — cache miss (scenario 1)', () => {
  it('returns 200 with offers from supplier', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.offers.length).toBeGreaterThan(0);
  });

  it('each offer has the required car fields', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    const offer = res.body.offers[0];
    expect(offer).toMatchObject({
      vehicleClass: expect.any(String),
      totalPrice: expect.any(Number),
      currency: expect.any(String),
      pickupLocationId: expect.any(String),
      dropoffLocationId: expect.any(String),
      supplier: expect.any(String),
      provenance: expect.any(String),
      bookable: expect.any(Boolean),
      expiresAt: expect.any(String),
    });
  });

  it('freshness.stale is false on cache miss', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.body.freshness.stale).toBe(false);
  });

  it('SUCCEEDED supplier shown as "available"', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    const outcome = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'RAPIDAPI',
    );
    expect(outcome?.outcome).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Cache hit
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — cache hit (scenario 2)', () => {
  it('returns 200 without calling supplier', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: CarSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('fresh'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ carSearchService: createCarSearchService(svcDeps) });
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Invalid dates — zero supplier calls
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — date rejection (scenario 3)', () => {
  it('rejects inverted dates with 400 and no supplier calls', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: CarSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('miss'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ carSearchService: createCarSearchService(svcDeps) });
    const res = await request(app).post('/v1/cars/search').send({
      ...VALID_BODY,
      pickupDate: '2099-06-18T12:00:00.000Z',
      dropoffDate: '2099-06-15T12:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('rejects same-datetime window with 400 and no supplier calls', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: CarSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('miss'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ carSearchService: createCarSearchService(svcDeps) });
    const res = await request(app).post('/v1/cars/search').send({
      ...VALID_BODY,
      pickupDate: '2099-06-15T12:00:00.000Z',
      dropoffDate: '2099-06-15T12:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('rejects past pickup date with 400 and no supplier calls', async () => {
    const supplier = makeFixtureSupplier('RAPIDAPI');
    const svcDeps: CarSearchServiceDeps = {
      suppliers: [supplier],
      cacheRepository: makeFakeCache('miss'),
      normaliser: makePassthroughNormaliser(),
      ranker: makeIdentityRanker(),
      clock: FIXED_CLOCK,
    };
    const app = createApp({ carSearchService: createCarSearchService(svcDeps) });
    const res = await request(app).post('/v1/cars/search').send({
      ...VALID_BODY,
      pickupDate: '2020-01-10T12:00:00.000Z',
      dropoffDate: '2020-01-13T12:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('rejection response names the invalid field', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send({
      ...VALID_BODY,
      pickupDate: '2099-06-18T12:00:00.000Z',
      dropoffDate: '2099-06-15T12:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ field: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: UNKNOWN vehicle class retained
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — UNKNOWN class fixture (scenario 4)', () => {
  it('returns UNKNOWN vehicleClass in offers without dropping it', async () => {
    const app = buildApp({
      suppliers: [makeFixtureSupplier('RAPIDAPI', [makeFixtureOffer('u-1', 'UNKNOWN')])],
    });
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    const offer = res.body.offers.find(
      (o: Record<string, unknown>) => o['vehicleClass'] === 'UNKNOWN',
    );
    expect(offer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: All suppliers down — empty state
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — all suppliers down (scenario 5)', () => {
  it('returns 200 (not 5xx) with emptyState', async () => {
    const app = buildApp({ suppliers: [makeFailingSupplier('RAPIDAPI')] });
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.emptyState).toMatchObject({
      reason: expect.any(String),
      alternativePickupWindows: expect.any(Array),
    });
  });

  it('alternativePickupWindows entries contain pickupDate and dropoffDate', async () => {
    const app = buildApp({ suppliers: [makeFailingSupplier('RAPIDAPI')] });
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    if (res.body.emptyState.alternativePickupWindows.length > 0) {
      const first = res.body.emptyState.alternativePickupWindows[0];
      expect(first).toMatchObject({
        pickupDate: expect.any(String),
        dropoffDate: expect.any(String),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Guest access
// ---------------------------------------------------------------------------

describe('POST /v1/cars/search — guest access', () => {
  it('returns 200 without Authorization header', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/cars/search').send(VALID_BODY);
    expect(res.status).toBe(200);
  });
});
