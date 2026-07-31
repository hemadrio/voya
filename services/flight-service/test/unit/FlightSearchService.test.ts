/**
 * Unit tests for FlightSearchService.
 *
 * Covers:
 *   - Cache hit (fresh) — no supplier call, offers returned immediately.
 *   - Cache miss — suppliers called, offers normalised and ranked.
 *   - Partial supplier failure — attributed outcomes, offers from success.
 *   - All suppliers failed — empty-state with alternative dates, HTTP 200.
 *   - Stale cache hit — served immediately, background refresh triggered.
 */
import { describe, it, expect, vi } from 'vitest';
import { createFlightSearchService } from '../../src/domain/FlightSearchService.js';
import type {
  FlightSearchServiceDeps,
  IFlightSearchService,
} from '../../src/domain/FlightSearchService.js';
import type { FlightSearchRequest } from '@travel/contracts';
import type { Offer } from '@travel/contracts';
import type { SupplierPort, SearchCriteria } from '@travel/supplier-port';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { CacheGetResult, CachedSearchPayload } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// FlightSearchRequest.departureDate is Date (from isoDateString → z.coerce.date())
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
    details: { cabinClass: 'ECONOMY', stops: 0, supplier: 'AMADEUS' },
    expiresAt: new Date('2099-12-31') as unknown as Date,
    freshness: 'FRESH',
  };
}

function makeRankedOffer(id: string): RankedOffer {
  return { offer: makeOffer(id) };
}

function makeSupplier(name: string, offers: Offer[] = []): SupplierPort {
  return {
    supplierName: name,
    supportedFlows: ['INSTANT'],
    searchOffers: vi.fn(async () => offers),
  };
}

function makeNormaliser(out: Offer[] = []) {
  return { normalise: vi.fn(() => out) };
}

function makeRanker(out: RankedOffer[] = []) {
  return { rank: vi.fn((_offers: Offer[], _prefs: MemberPreferences) => out) };
}

const FIXED_NOW = Date.UTC(2099, 5, 10); // June 10 2099

function makeCache(hit: CacheGetResult | null = null, available = true) {
  return {
    get: vi.fn(async () => hit),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async () => hit),
    isAvailable: vi.fn(() => available),
  };
}

function makeDeps(overrides: Partial<FlightSearchServiceDeps> = {}): FlightSearchServiceDeps {
  return {
    suppliers: [makeSupplier('AMADEUS', [makeOffer('o1')])],
    cacheRepository: makeCache() as unknown as FlightSearchServiceDeps['cacheRepository'],
    normaliser: makeNormaliser([makeOffer('o1')]) as unknown as FlightSearchServiceDeps['normaliser'],
    ranker: makeRanker([makeRankedOffer('o1')]) as unknown as FlightSearchServiceDeps['ranker'],
    clock: { now: () => FIXED_NOW },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cache miss — full supplier fan-out
// ---------------------------------------------------------------------------

describe('FlightSearchService — cache miss', () => {
  it('calls the supplier when cache returns null', async () => {
    const supplier = makeSupplier('AMADEUS', [makeOffer('o1')]);
    const svc = createFlightSearchService(makeDeps({ suppliers: [supplier] }));
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).toHaveBeenCalledOnce();
  });

  it('returns ranked offers with SUCCEEDED outcome', async () => {
    const svc = createFlightSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.offers).toHaveLength(1);
    expect(result.supplierOutcomes[0]!.outcome).toBe('SUCCEEDED');
  });

  it('includes freshness with stale=false on cache miss', async () => {
    const svc = createFlightSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(false);
    expect(result.freshness.generatedAt).toBeInstanceOf(Date);
  });

  it('writes result to cache after fan-out', async () => {
    const cache = makeCache(null);
    const svc = createFlightSearchService(
      makeDeps({ cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'] }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it('no emptyState when offers are returned', async () => {
    const svc = createFlightSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.emptyState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache hit (fresh)
// ---------------------------------------------------------------------------

describe('FlightSearchService — cache hit (fresh)', () => {
  function makeFreshHit(): CacheGetResult {
    const payload: CachedSearchPayload = {
      schemaVersion: 1,
      generatedAt: FIXED_NOW - 10_000,
      offers: [makeOffer('cached-1') as unknown as Record<string, unknown>],
      supplierOutcomes: [{ supplier: 'AMADEUS', outcome: 'SUCCEEDED' }],
    };
    return {
      payload,
      stale: false,
      generatedAt: new Date(FIXED_NOW - 10_000),
      key: 'search:flight:abc123',
    };
  }

  it('does not call the supplier on a fresh cache hit', async () => {
    const supplier = makeSupplier('AMADEUS', [makeOffer('o1')]);
    const cache = makeCache(makeFreshHit());
    const svc = createFlightSearchService(
      makeDeps({
        suppliers: [supplier],
        cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('returns stale=false and cached generatedAt', async () => {
    const hit = makeFreshHit();
    const cache = makeCache(hit);
    const svc = createFlightSearchService(
      makeDeps({ cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(false);
    expect(result.freshness.generatedAt).toEqual(hit.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// Stale cache hit
// ---------------------------------------------------------------------------

describe('FlightSearchService — stale cache hit', () => {
  function makeStaleHit(): CacheGetResult {
    const payload: CachedSearchPayload = {
      schemaVersion: 1,
      generatedAt: FIXED_NOW - 200_000,
      offers: [makeOffer('stale-1') as unknown as Record<string, unknown>],
      supplierOutcomes: [{ supplier: 'AMADEUS', outcome: 'SUCCEEDED' }],
    };
    return {
      payload,
      stale: true,
      generatedAt: new Date(FIXED_NOW - 200_000),
      key: 'search:flight:abc123',
    };
  }

  it('returns stale=true when cache entry is stale', async () => {
    const cache = makeCache(makeStaleHit());
    const svc = createFlightSearchService(
      makeDeps({ cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(true);
  });

  it('does not call supplier directly for stale hit (background refresh handles it)', async () => {
    const supplier = makeSupplier('AMADEUS', [makeOffer('o1')]);
    const cache = makeCache(makeStaleHit());
    const svc = createFlightSearchService(
      makeDeps({
        suppliers: [supplier],
        cacheRepository: cache as unknown as FlightSearchServiceDeps['cacheRepository'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Partial supplier failure
// ---------------------------------------------------------------------------

describe('FlightSearchService — partial supplier failure', () => {
  it('attributes failed supplier in outcomes', async () => {
    const failingSupplier: SupplierPort = {
      supplierName: 'RAPIDAPI',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('network error'); }),
    };
    const successSupplier = makeSupplier('AMADEUS', [makeOffer('o1')]);
    const svc = createFlightSearchService(
      makeDeps({ suppliers: [successSupplier, failingSupplier] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    const failed = result.supplierOutcomes.find((o) => o.supplier === 'RAPIDAPI');
    expect(failed?.outcome).toBe('FAILED');
  });

  it('still returns offers from the successful supplier', async () => {
    const failingSupplier: SupplierPort = {
      supplierName: 'RAPIDAPI',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('network error'); }),
    };
    const successSupplier = makeSupplier('AMADEUS', [makeOffer('o1')]);
    const ranker = makeRanker([makeRankedOffer('o1')]);
    const svc = createFlightSearchService(
      makeDeps({ suppliers: [successSupplier, failingSupplier], ranker: ranker as unknown as FlightSearchServiceDeps['ranker'] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.offers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// All suppliers failed → empty state
// ---------------------------------------------------------------------------

describe('FlightSearchService — all suppliers failed (empty state)', () => {
  it('returns emptyState with alternativeDates when all suppliers fail and no offers', async () => {
    const failingSupplier: SupplierPort = {
      supplierName: 'AMADEUS',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('down'); }),
    };
    const emptyNormaliser = makeNormaliser([]);
    const emptyRanker = makeRanker([]);
    const svc = createFlightSearchService(
      makeDeps({
        suppliers: [failingSupplier],
        normaliser: emptyNormaliser as unknown as FlightSearchServiceDeps['normaliser'],
        ranker: emptyRanker as unknown as FlightSearchServiceDeps['ranker'],
      }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.emptyState).toBeDefined();
    expect(result.emptyState?.alternativeDates.length).toBeGreaterThan(0);
    expect(result.offers).toHaveLength(0);
  });

  it('does not trigger additional supplier calls for alternative dates', async () => {
    const failingSupplier: SupplierPort = {
      supplierName: 'AMADEUS',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('down'); }),
    };
    const svc = createFlightSearchService(
      makeDeps({
        suppliers: [failingSupplier],
        normaliser: makeNormaliser([]) as unknown as FlightSearchServiceDeps['normaliser'],
        ranker: makeRanker([]) as unknown as FlightSearchServiceDeps['ranker'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    // searchOffers was called exactly once (the initial fan-out), not more
    expect(failingSupplier.searchOffers).toHaveBeenCalledOnce();
  });

  it('returns HTTP-200-compatible result (no throw)', async () => {
    const failingSupplier: SupplierPort = {
      supplierName: 'AMADEUS',
      supportedFlows: ['INSTANT'],
      searchOffers: vi.fn(async () => { throw new Error('down'); }),
    };
    const svc = createFlightSearchService(
      makeDeps({
        suppliers: [failingSupplier],
        normaliser: makeNormaliser([]) as unknown as FlightSearchServiceDeps['normaliser'],
        ranker: makeRanker([]) as unknown as FlightSearchServiceDeps['ranker'],
      }),
    );
    await expect(svc.search(VALID_REQUEST, 'corr-1')).resolves.toBeDefined();
  });
});
