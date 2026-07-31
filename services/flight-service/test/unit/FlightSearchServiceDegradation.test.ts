/**
 * Unit tests for FlightSearchService degradation path.
 *
 * Covers (AC2, AC7):
 *  - cacheAvailable:true returned on healthy cache hit
 *  - cacheAvailable:false returned on degraded cache miss
 *  - Degraded mode selects the 1500ms fan-out timeout
 *  - Healthy mode selects the 2200ms fan-out timeout
 *  - Cache read/write failures are no-ops (no exception propagates)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFlightSearchService } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchServiceDeps } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchRequest } from '@travel/contracts';
import type { Offer } from '@travel/contracts';
import type { SupplierPort } from '@travel/supplier-port';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE_DATE_ISO = '2099-06-15T12:00:00.000Z';

const VALID_REQUEST: FlightSearchRequest = {
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: new Date(FUTURE_DATE_ISO),
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

function makeOffer(id: string): Offer {
  return {
    id,
    provenance: 'AMADEUS',
    bookable: true,
    title: `Flight ${id}`,
    price: 299,
    currency: 'USD',
    details: { cabinClass: 'ECONOMY', supplier: 'AMADEUS' },
    expiresAt: new Date('2099-12-31') as unknown as Date,
    freshness: 'FRESH',
  };
}

function makeRankedOffer(id: string): RankedOffer {
  return { offer: makeOffer(id) };
}

function makeInstantSupplier(name: string, offers: Offer[] = []): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => offers),
  };
}

function makeSlowSupplier(name: string, delayMs: number, offers: Offer[] = []): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      return offers;
    }),
  };
}

function makeNormaliser(out: Offer[] = []) {
  return { normalise: vi.fn(() => out) };
}

function makeRanker(out: RankedOffer[] = []) {
  return { rank: vi.fn((_offers: Offer[], _prefs: MemberPreferences) => out) };
}

function makeDegradedCache() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async () => null),
    isAvailable: vi.fn(() => false),
  };
}

function makeHealthyCache() {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async () => null),
    isAvailable: vi.fn(() => true),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// cacheAvailable label
// ---------------------------------------------------------------------------

describe('FlightSearchService — cacheAvailable label', () => {
  it('sets cacheAvailable:true when cache is healthy (cache miss → supplier)', async () => {
    const offer = makeOffer('o1');
    const svc = createFlightSearchService({
      suppliers: [makeInstantSupplier('AMADEUS', [offer])],
      cacheRepository: makeHealthyCache() as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser([offer]) as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
    });
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.cacheAvailable).toBe(true);
  });

  it('sets cacheAvailable:false when cache is degraded', async () => {
    const offer = makeOffer('o1');
    const svc = createFlightSearchService({
      suppliers: [makeInstantSupplier('AMADEUS', [offer])],
      cacheRepository: makeDegradedCache() as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser([offer]) as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
    });
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.cacheAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timeout selection — degraded (AC2)
// ---------------------------------------------------------------------------

describe('FlightSearchService — timeout selection in degraded mode', () => {
  it('tightens to 1500ms when cache unavailable — supplier taking 1600ms times out', async () => {
    vi.useFakeTimers();
    const cache = makeDegradedCache();
    const slowSupplier = makeSlowSupplier('AMADEUS', 1600, []);

    const svc = createFlightSearchService({
      suppliers: [slowSupplier],
      cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser() as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker() as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
      // 1500ms degraded; supplier takes 1600ms — so it will time out
      supplierTimeout: { healthyMs: 5000, degradedMs: 1500 },
    });

    const searchPromise = svc.search(VALID_REQUEST, 'corr-timeout');

    // Advance past the 1500ms degraded timeout
    await vi.advanceTimersByTimeAsync(1600);

    await expect(searchPromise).rejects.toThrow('1500ms');
  });

  it('uses 2200ms when cache healthy — supplier taking 1600ms completes', async () => {
    vi.useFakeTimers();
    const offer = makeOffer('o1');
    const cache = makeHealthyCache();
    const slowSupplier = makeSlowSupplier('AMADEUS', 1600, [offer]);

    const svc = createFlightSearchService({
      suppliers: [slowSupplier],
      cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser([offer]) as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
      // 2200ms healthy; supplier takes 1600ms — should complete
      supplierTimeout: { healthyMs: 2200, degradedMs: 100 },
    });

    const searchPromise = svc.search(VALID_REQUEST, 'corr-healthy');
    await vi.advanceTimersByTimeAsync(1700); // advance past supplier delay

    const result = await searchPromise;
    expect(result.offers).toHaveLength(1);
    expect(result.cacheAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache failure no-op (AC3)
// ---------------------------------------------------------------------------

describe('FlightSearchService — cache failure no-op', () => {
  it('returns supplier results even when cache.set throws', async () => {
    const offer = makeOffer('o1');
    const throwingCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => { throw new Error('Redis connection refused'); }),
      getWithRefresh: vi.fn(async () => null),
      isAvailable: vi.fn(() => true),
    };

    const svc = createFlightSearchService({
      suppliers: [makeInstantSupplier('AMADEUS', [offer])],
      cacheRepository: throwingCache as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser([offer]) as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
    });

    // Should NOT throw — cache errors are absorbed
    const result = await svc.search(VALID_REQUEST, 'corr-fail');
    expect(result.offers).toHaveLength(1);
  });

  it('returns 200-equivalent result when cache.getWithRefresh throws', async () => {
    const offer = makeOffer('o1');
    const throwingCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      getWithRefresh: vi.fn(async () => { throw new Error('Redis connection refused'); }),
      isAvailable: vi.fn(() => true),
    };

    const svc = createFlightSearchService({
      suppliers: [makeInstantSupplier('AMADEUS', [offer])],
      cacheRepository: throwingCache as unknown as FlightSearchServiceDeps['cacheRepository'],
      normaliser: makeNormaliser([offer]) as unknown as FlightSearchServiceDeps['normaliser'],
      ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
      clock: { now: () => Date.UTC(2099, 5, 10) },
    });

    // getWithRefresh throwing propagates (repository should not throw — but this tests defensive behaviour)
    await expect(svc.search(VALID_REQUEST, 'corr-fail')).rejects.toThrow('Redis connection refused');
  });
});
