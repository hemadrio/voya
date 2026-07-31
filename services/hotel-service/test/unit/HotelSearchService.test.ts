/**
 * Unit tests for HotelSearchService.
 *
 * Covers:
 *   - Cache miss — supplier called, offers ranked, cache written.
 *   - Cache hit (fresh) — supplier not called.
 *   - Stale cache hit — stale=true, no direct supplier call.
 *   - Partial supplier failure — attributed outcomes, offers from success.
 *   - All suppliers failed — empty state with alternative stay dates.
 *   - Star preference reorders results but does not filter.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHotelSearchService } from '../../src/domain/HotelSearchService.js';
import type { HotelSearchServiceDeps } from '../../src/domain/HotelSearchService.js';
import type { HotelSearchRequest } from '@travel/contracts';
import type { Offer } from '@travel/contracts';
import type { SupplierPort } from '@travel/supplier-port';
import type { RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { CacheGetResult, CachedSearchPayload, BackgroundRefreshFn } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2099, 5, 10); // June 10 2099

const VALID_REQUEST: HotelSearchRequest = {
  location: 'New York',
  checkInDate: new Date('2099-07-10T14:00:00.000Z'),
  checkOutDate: new Date('2099-07-13T11:00:00.000Z'),
  guests: 2,
  currency: 'USD',
};

function makeOffer(id: string, starRating?: number): Offer {
  return {
    id,
    provenance: 'RAPIDAPI',
    bookable: true,
    title: `Hotel ${id}`,
    price: 150,
    currency: 'USD',
    details: { supplier: 'RAPIDAPI', totalPrice: 450, nightlyPrice: 150, nights: 3 },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
    ...(starRating !== undefined ? { rating: starRating } : {}),
  };
}

function makeRanked(id: string, starRating?: number): RankedOffer {
  return { offer: makeOffer(id, starRating) };
}

function makeSupplier(name: string, offers: Offer[] = [makeOffer(name + '-1')]): SupplierPort {
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
    searchOffers: vi.fn(async () => { throw new Error('down'); }),
  };
}

function makeNormaliser(out: Offer[] = [makeOffer('n1')]) {
  return { normalise: vi.fn(() => out) };
}

function makeRanker(out: RankedOffer[] = [makeRanked('n1')]) {
  return { rank: vi.fn((_offers: Offer[], _prefs: MemberPreferences) => out) };
}

function makeCache(hit: CacheGetResult | null = null) {
  return {
    get: vi.fn(async () => hit),
    set: vi.fn(async () => {}),
    getWithRefresh: vi.fn(async (
      _cat: string,
      _params: Record<string, unknown>,
      _fn: BackgroundRefreshFn,
      _cid: string,
    ) => hit),
  };
}

function makeDeps(overrides: Partial<HotelSearchServiceDeps> = {}): HotelSearchServiceDeps {
  return {
    suppliers: [makeSupplier('RAPIDAPI')],
    cacheRepository: makeCache() as unknown as HotelSearchServiceDeps['cacheRepository'],
    normaliser: makeNormaliser() as unknown as HotelSearchServiceDeps['normaliser'],
    ranker: makeRanker() as unknown as HotelSearchServiceDeps['ranker'],
    clock: { now: () => FIXED_NOW },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe('HotelSearchService — cache miss', () => {
  it('calls the supplier on cache miss', async () => {
    const supplier = makeSupplier('RAPIDAPI');
    const svc = createHotelSearchService(makeDeps({ suppliers: [supplier] }));
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).toHaveBeenCalledOnce();
  });

  it('returns SUCCEEDED outcome and offers', async () => {
    const svc = createHotelSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.offers).toHaveLength(1);
    expect(result.supplierOutcomes[0]!.outcome).toBe('SUCCEEDED');
  });

  it('writes to cache after fan-out', async () => {
    const cache = makeCache(null);
    const svc = createHotelSearchService(
      makeDeps({ cacheRepository: cache as unknown as HotelSearchServiceDeps['cacheRepository'] }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it('freshness.stale is false on cache miss', async () => {
    const svc = createHotelSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(false);
  });

  it('no emptyState when offers returned', async () => {
    const svc = createHotelSearchService(makeDeps());
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.emptyState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache hit (fresh)
// ---------------------------------------------------------------------------

describe('HotelSearchService — cache hit fresh', () => {
  function makeFreshHit(): CacheGetResult {
    const payload: CachedSearchPayload = {
      schemaVersion: 1,
      generatedAt: FIXED_NOW - 10_000,
      offers: [makeOffer('cached-1') as unknown as Record<string, unknown>],
      supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
    };
    return { payload, stale: false, generatedAt: new Date(FIXED_NOW - 10_000), key: 'k1' };
  }

  it('does not call supplier on fresh cache hit', async () => {
    const supplier = makeSupplier('RAPIDAPI');
    const svc = createHotelSearchService(
      makeDeps({
        suppliers: [supplier],
        cacheRepository: makeCache(makeFreshHit()) as unknown as HotelSearchServiceDeps['cacheRepository'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });

  it('returns stale=false on fresh hit', async () => {
    const svc = createHotelSearchService(
      makeDeps({ cacheRepository: makeCache(makeFreshHit()) as unknown as HotelSearchServiceDeps['cacheRepository'] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stale cache hit
// ---------------------------------------------------------------------------

describe('HotelSearchService — stale cache hit', () => {
  function makeStaleHit(): CacheGetResult {
    const payload: CachedSearchPayload = {
      schemaVersion: 1,
      generatedAt: FIXED_NOW - 200_000,
      offers: [makeOffer('stale-1') as unknown as Record<string, unknown>],
      supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
    };
    return { payload, stale: true, generatedAt: new Date(FIXED_NOW - 200_000), key: 'k2' };
  }

  it('returns stale=true for stale hit', async () => {
    const svc = createHotelSearchService(
      makeDeps({ cacheRepository: makeCache(makeStaleHit()) as unknown as HotelSearchServiceDeps['cacheRepository'] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.freshness.stale).toBe(true);
  });

  it('does not call supplier directly for stale hit', async () => {
    const supplier = makeSupplier('RAPIDAPI');
    const svc = createHotelSearchService(
      makeDeps({
        suppliers: [supplier],
        cacheRepository: makeCache(makeStaleHit()) as unknown as HotelSearchServiceDeps['cacheRepository'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(supplier.searchOffers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Partial supplier failure
// ---------------------------------------------------------------------------

describe('HotelSearchService — partial failure', () => {
  it('attributes the failed supplier', async () => {
    const svc = createHotelSearchService(
      makeDeps({ suppliers: [makeSupplier('RAPIDAPI'), makeFailingSupplier('SECOND')] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    const failed = result.supplierOutcomes.find((o) => o.supplier === 'SECOND');
    expect(failed?.outcome).toBe('FAILED');
  });

  it('still returns offers from working supplier', async () => {
    const svc = createHotelSearchService(
      makeDeps({ suppliers: [makeSupplier('RAPIDAPI'), makeFailingSupplier('SECOND')] }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.offers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// All suppliers failed — empty state
// ---------------------------------------------------------------------------

describe('HotelSearchService — all suppliers failed', () => {
  it('returns emptyState with alternativeStayDates', async () => {
    const svc = createHotelSearchService(
      makeDeps({
        suppliers: [makeFailingSupplier('RAPIDAPI')],
        normaliser: makeNormaliser([]) as unknown as HotelSearchServiceDeps['normaliser'],
        ranker: makeRanker([]) as unknown as HotelSearchServiceDeps['ranker'],
      }),
    );
    const result = await svc.search(VALID_REQUEST, 'corr-1');
    expect(result.emptyState).toBeDefined();
    expect(Array.isArray(result.emptyState?.alternativeStayDates)).toBe(true);
    expect(result.offers).toHaveLength(0);
  });

  it('does not make extra supplier calls for alternative dates', async () => {
    const failing = makeFailingSupplier('RAPIDAPI');
    const svc = createHotelSearchService(
      makeDeps({
        suppliers: [failing],
        normaliser: makeNormaliser([]) as unknown as HotelSearchServiceDeps['normaliser'],
        ranker: makeRanker([]) as unknown as HotelSearchServiceDeps['ranker'],
      }),
    );
    await svc.search(VALID_REQUEST, 'corr-1');
    expect(failing.searchOffers).toHaveBeenCalledOnce();
  });

  it('resolves (does not throw) when all suppliers fail', async () => {
    const svc = createHotelSearchService(
      makeDeps({
        suppliers: [makeFailingSupplier('RAPIDAPI')],
        normaliser: makeNormaliser([]) as unknown as HotelSearchServiceDeps['normaliser'],
        ranker: makeRanker([]) as unknown as HotelSearchServiceDeps['ranker'],
      }),
    );
    await expect(svc.search(VALID_REQUEST, 'corr-1')).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Star preference — ordering only, not filtering
// ---------------------------------------------------------------------------

describe('HotelSearchService — star preference ordering', () => {
  it('returns both properties regardless of star preference', async () => {
    const offers = [makeOffer('a', 3), makeOffer('b', 5)];
    const ranked = [makeRanked('b', 5), makeRanked('a', 3)]; // 5-star first
    const ranker = makeRanker(ranked);
    const svc = createHotelSearchService(
      makeDeps({
        normaliser: makeNormaliser(offers) as unknown as HotelSearchServiceDeps['normaliser'],
        ranker: ranker as unknown as HotelSearchServiceDeps['ranker'],
      }),
    );
    const prefs: MemberPreferences = { minHotelStars: 4 };
    const result = await svc.search(VALID_REQUEST, 'corr-1', prefs);
    // Both properties present — ranking may change but neither is dropped
    expect(result.offers).toHaveLength(2);
  });
});
