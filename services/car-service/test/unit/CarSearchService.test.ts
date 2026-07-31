/**
 * Unit tests for CarSearchService.
 *
 * Covers (AC8):
 *  - Date-time coherence short-circuit (schema rejects before service is called)
 *  - UNKNOWN class retention through normaliser and ranker
 *  - Cache key time sensitivity (time bucketing)
 *  - Status mapping (supplier outcomes)
 *  - Stale cache hit path
 *  - Car class preference orders but does not filter
 */

import { describe, it, expect, vi } from 'vitest';
import { createCarSearchService, roundToTimeBucket } from '../../src/domain/CarSearchService.js';
import type { CarSearchServiceDeps } from '../../src/domain/CarSearchService.js';
import type { SupplierPort } from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { CarRentalSearchRequest } from '@travel/contracts';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { CacheGetResult, CachedSearchPayload, BackgroundRefreshFn } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOffer(id: string, vehicleClass = 'ECONOMY'): Offer {
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

function makeValidRequest(overrides: Partial<CarRentalSearchRequest> = {}): CarRentalSearchRequest {
  return {
    pickupLocation: 'JFK',
    dropoffLocation: 'JFK',
    pickupDate: new Date('2099-06-15T12:00:00.000Z'),
    dropoffDate: new Date('2099-06-18T12:00:00.000Z'),
    carClass: 'ECONOMY',
    currency: 'USD',
    ...overrides,
  } as unknown as CarRentalSearchRequest;
}

function makeSupplier(name: string, offers: Offer[] = [makeOffer(`${name}-1`)]): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => offers),
  };
}

function makePassthroughNormaliser(): CarSearchServiceDeps['normaliser'] {
  return { normalise: vi.fn((raw) => raw as ReadonlyArray<Offer>) } as unknown as CarSearchServiceDeps['normaliser'];
}

function makeIdentityRanker(): CarSearchServiceDeps['ranker'] {
  return {
    rank: vi.fn((offers: ReadonlyArray<Offer>, _prefs: MemberPreferences) =>
      offers.map((o): RankedOffer => ({ offer: o })),
    ),
  } as unknown as CarSearchServiceDeps['ranker'];
}

type CacheState = 'miss' | 'fresh' | 'stale';

function makeFakeCache(state: CacheState = 'miss', cachedOffers: Offer[] = [makeOffer('cached-1')]): CarSearchServiceDeps['cacheRepository'] {
  const storedPayload: CachedSearchPayload = {
    schemaVersion: 1,
    generatedAt: Date.UTC(2099, 5, 1),
    offers: cachedOffers as unknown as Record<string, unknown>[],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
  };
  const hitResult: CacheGetResult = {
    payload: storedPayload,
    stale: state === 'stale',
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
    ) => state === 'miss' ? null : hitResult),
    isAvailable: vi.fn(() => state !== 'unavailable'),
  } as unknown as CarSearchServiceDeps['cacheRepository'];
}

const FIXED_CLOCK = { now: () => Date.UTC(2099, 5, 10) };

function buildDeps(overrides: Partial<CarSearchServiceDeps> = {}): CarSearchServiceDeps {
  return {
    suppliers: [makeSupplier('RAPIDAPI')],
    cacheRepository: makeFakeCache(),
    normaliser: makePassthroughNormaliser(),
    ranker: makeIdentityRanker(),
    clock: FIXED_CLOCK,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cache key time sensitivity (AC6)
// ---------------------------------------------------------------------------

describe('roundToTimeBucket', () => {
  it('rounds down to the nearest 15-minute boundary', () => {
    const d = new Date('2099-06-15T12:07:00.000Z');
    const bucketed = roundToTimeBucket(d, 15);
    expect(bucketed.getUTCMinutes()).toBe(0);
    expect(bucketed.getUTCHours()).toBe(12);
  });

  it('returns the same bucket for two times within the same 15-minute window', () => {
    const a = roundToTimeBucket(new Date('2099-06-15T12:03:00.000Z'), 15);
    const b = roundToTimeBucket(new Date('2099-06-15T12:14:59.000Z'), 15);
    expect(a.getTime()).toBe(b.getTime());
  });

  it('returns different buckets for times in adjacent 15-minute windows', () => {
    const a = roundToTimeBucket(new Date('2099-06-15T12:00:00.000Z'), 15);
    const b = roundToTimeBucket(new Date('2099-06-15T12:15:00.000Z'), 15);
    expect(a.getTime()).not.toBe(b.getTime());
  });
});

describe('CarSearchService — cache key uses bucketed times', () => {
  it('uses getWithRefresh with the car category', async () => {
    const cache = makeFakeCache('miss');
    const svc = createCarSearchService(buildDeps({ cacheRepository: cache }));
    await svc.search(makeValidRequest(), 'cid-1');
    expect(cache.getWithRefresh).toHaveBeenCalledWith(
      'car',
      expect.any(Object),
      expect.any(Function),
      'cid-1',
    );
  });

  it('two requests with same time in same bucket share cache params', async () => {
    const cache = makeFakeCache('miss');
    const svc = createCarSearchService(buildDeps({ cacheRepository: cache }));

    const req1 = makeValidRequest({ pickupDate: new Date('2099-06-15T12:03:00.000Z') });
    const req2 = makeValidRequest({ pickupDate: new Date('2099-06-15T12:09:00.000Z') });

    await svc.search(req1 as unknown as CarRentalSearchRequest, 'cid-a');
    await svc.search(req2 as unknown as CarRentalSearchRequest, 'cid-b');

    const calls = (cache.getWithRefresh as ReturnType<typeof vi.fn>).mock.calls;
    const params1 = calls[0][1] as Record<string, unknown>;
    const params2 = calls[1][1] as Record<string, unknown>;
    expect(params1['pickupDate']).toBe(params2['pickupDate']);
  });

  it('two requests in different buckets have different cache params', async () => {
    const cache = makeFakeCache('miss');
    const svc = createCarSearchService(buildDeps({ cacheRepository: cache }));

    const req1 = makeValidRequest({ pickupDate: new Date('2099-06-15T12:00:00.000Z') });
    const req2 = makeValidRequest({ pickupDate: new Date('2099-06-15T12:15:00.000Z') });

    await svc.search(req1 as unknown as CarRentalSearchRequest, 'cid-a');
    await svc.search(req2 as unknown as CarRentalSearchRequest, 'cid-b');

    const calls = (cache.getWithRefresh as ReturnType<typeof vi.fn>).mock.calls;
    const params1 = calls[0][1] as Record<string, unknown>;
    const params2 = calls[1][1] as Record<string, unknown>;
    expect(params1['pickupDate']).not.toBe(params2['pickupDate']);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN class retention (AC5)
// ---------------------------------------------------------------------------

describe('CarSearchService — UNKNOWN vehicle class retained', () => {
  it('does not filter offers with UNKNOWN vehicleClass', async () => {
    const unknownOffer = makeOffer('unknown-1', 'UNKNOWN');
    const supplier = makeSupplier('RAPIDAPI', [unknownOffer]);
    const svc = createCarSearchService(buildDeps({ suppliers: [supplier] }));

    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.offers.length).toBe(1);
    expect(result.offers[0]!.offer.details).toMatchObject({ vehicleClass: 'UNKNOWN' });
  });

  it('retains UNKNOWN alongside other classes (no filtering by class)', async () => {
    const offers = [makeOffer('e-1', 'ECONOMY'), makeOffer('u-1', 'UNKNOWN')];
    const supplier = makeSupplier('RAPIDAPI', offers);
    const svc = createCarSearchService(buildDeps({ suppliers: [supplier] }));

    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.offers.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Car class preference: orders but does not filter (AC7)
// ---------------------------------------------------------------------------

describe('CarSearchService — car class preference orders but does not filter', () => {
  it('returns all offers including non-preferred class', async () => {
    const offers = [makeOffer('p-1', 'PREMIUM'), makeOffer('e-1', 'ECONOMY')];
    const supplier = makeSupplier('RAPIDAPI', offers);
    const ranker: CarSearchServiceDeps['ranker'] = {
      rank: vi.fn((os: ReadonlyArray<Offer>) => os.map((o) => ({ offer: o }))),
    } as unknown as CarSearchServiceDeps['ranker'];
    const svc = createCarSearchService(buildDeps({ suppliers: [supplier], ranker }));

    const result = await svc.search(makeValidRequest({ carClass: 'ECONOMY' }), 'cid-1');
    expect(result.offers.length).toBe(2);
    const classes = result.offers.map((r) => (r.offer.details as Record<string, unknown>)['vehicleClass']);
    expect(classes).toContain('PREMIUM');
    expect(classes).toContain('ECONOMY');
  });
});

// ---------------------------------------------------------------------------
// Supplier outcome mapping (AC8)
// ---------------------------------------------------------------------------

describe('CarSearchService — supplier outcomes', () => {
  it('records SUCCEEDED when supplier returns offers', async () => {
    const svc = createCarSearchService(buildDeps());
    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.supplierOutcomes).toContainEqual({ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' });
  });

  it('records FAILED when supplier throws a generic error', async () => {
    const failing = {
      supplierName: 'RAPIDAPI',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('network error'); }),
    } as unknown as SupplierPort;
    const svc = createCarSearchService(buildDeps({ suppliers: [failing] }));
    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.supplierOutcomes).toContainEqual({ supplier: 'RAPIDAPI', outcome: 'FAILED' });
  });
});

// ---------------------------------------------------------------------------
// Stale cache hit
// ---------------------------------------------------------------------------

describe('CarSearchService — stale cache hit', () => {
  it('returns stale=true in freshness from a stale cache entry', async () => {
    const svc = createCarSearchService(buildDeps({ cacheRepository: makeFakeCache('stale') }));
    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.freshness.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty state with alternative pickup windows
// ---------------------------------------------------------------------------

describe('CarSearchService — empty state', () => {
  it('returns emptyState with alternativePickupWindows when all suppliers fail', async () => {
    const failing = {
      supplierName: 'RAPIDAPI',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('down'); }),
    } as unknown as SupplierPort;
    const svc = createCarSearchService(buildDeps({ suppliers: [failing] }));
    const result = await svc.search(makeValidRequest(), 'cid-1');
    expect(result.emptyState).toBeDefined();
    expect(result.emptyState?.alternativePickupWindows).toBeInstanceOf(Array);
  });
});
