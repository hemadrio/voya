/**
 * HotelSearchService — orchestrates cache probe, supplier fan-out, normalisation,
 * and ranking for hotel searches.
 *
 * Pipeline:
 *  1. Probe cache — fresh hit returns immediately.
 *  2. Stale hit — serve immediately with background refresh.
 *  3. Cache miss — parallel supplier fan-out via injected SupplierPort adapters.
 *  4. Normalise raw offers through OfferNormaliser (validates schema, drops expired).
 *  5. Rank via OfferRanker with optional member preferences (star preference).
 *  6. Write result to cache.
 *  7. If all suppliers failed, return empty-state with alternative stay dates.
 *
 * No business logic lives in the route or controller layer (WO-035 constraint).
 * All I/O dependencies are injected at construction time for testability.
 */

import type { Offer } from '@travel/contracts';
import type { HotelSearchRequest } from '@travel/contracts';
import type { SupplierPort, SearchCriteria } from '@travel/supplier-port';
import type { OfferNormaliser, OfferRanker, RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { SearchCacheRepository, CachedSearchPayload } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupplierCallOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_CIRCUIT_OPEN';

export interface SupplierOutcomeEntry {
  readonly supplier: string;
  readonly outcome: SupplierCallOutcome;
}

export interface HotelSearchFreshness {
  readonly generatedAt: Date;
  readonly stale: boolean;
}

export interface AlternativeStay {
  readonly checkInDate: string;
  readonly checkOutDate: string;
}

export interface HotelSearchEmptyState {
  readonly reason: string;
  readonly alternativeStayDates: AlternativeStay[];
}

export interface HotelSearchResult {
  readonly offers: RankedOffer[];
  readonly supplierOutcomes: SupplierOutcomeEntry[];
  readonly freshness: HotelSearchFreshness;
  readonly emptyState?: HotelSearchEmptyState;
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface HotelSearchServiceDeps {
  suppliers: SupplierPort[];
  cacheRepository: SearchCacheRepository;
  normaliser: OfferNormaliser;
  ranker: OfferRanker;
  clock?: { now(): number };
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  alternativeStayOffsetDays?: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface IHotelSearchService {
  search(
    request: HotelSearchRequest,
    correlationId: string,
    preferences?: MemberPreferences,
  ): Promise<HotelSearchResult>;
}

// ---------------------------------------------------------------------------
// Alternative stay date computation
// ---------------------------------------------------------------------------

function computeAlternativeStayDates(
  checkInDate: Date | string,
  checkOutDate: Date | string,
  offsetDays: number,
  nowMs: number,
): AlternativeStay[] {
  const checkIn = checkInDate instanceof Date ? checkInDate : new Date(String(checkInDate));
  const checkOut = checkOutDate instanceof Date ? checkOutDate : new Date(String(checkOutDate));
  const stayMs = checkOut.getTime() - checkIn.getTime();

  if (stayMs <= 0) return [];

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const todayStartMs = new Date(nowMs).setUTCHours(0, 0, 0, 0);
  const results: AlternativeStay[] = [];

  for (let offset = -offsetDays; offset <= offsetDays; offset++) {
    if (offset === 0) continue;

    const altCheckInMs = checkIn.getTime() + offset * ONE_DAY_MS;
    if (altCheckInMs <= todayStartMs) continue;

    const altCheckIn = new Date(altCheckInMs);
    const altCheckOut = new Date(altCheckInMs + stayMs);

    const fmt = (d: Date) => {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    results.push({ checkInDate: fmt(altCheckIn), checkOutDate: fmt(altCheckOut) });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHotelSearchService(deps: HotelSearchServiceDeps): IHotelSearchService {
  const {
    suppliers,
    cacheRepository,
    normaliser,
    ranker,
    alternativeStayOffsetDays = 3,
  } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const logger = deps.logger;

  async function backgroundRefresh(
    _category: string,
    params: Record<string, unknown>,
    correlationId: string,
  ): Promise<CachedSearchPayload> {
    const request = params as HotelSearchRequest;
    const { offers, supplierOutcomes } = await fanOutAndNormalise(request, correlationId);
    return {
      schemaVersion: 1,
      generatedAt: clock.now(),
      offers: offers.map((o) => o as unknown as Record<string, unknown>),
      supplierOutcomes,
    };
  }

  async function fanOutAndNormalise(
    request: HotelSearchRequest,
    correlationId: string,
  ): Promise<{ offers: Offer[]; supplierOutcomes: SupplierOutcomeEntry[] }> {
    const criteria: SearchCriteria = { ...request, kind: 'hotel' as const };

    const results = await Promise.allSettled(
      suppliers.map((adapter) => adapter.searchOffers(criteria, correlationId)),
    );

    const rawOffers: unknown[] = [];
    const supplierOutcomes: SupplierOutcomeEntry[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const supplierName = suppliers[i]!.supplierName;

      if (result.status === 'fulfilled') {
        supplierOutcomes.push({ supplier: supplierName, outcome: 'SUCCEEDED' });
        for (const offer of result.value) rawOffers.push(offer);
      } else {
        const err = result.reason as unknown;
        const outcome: SupplierCallOutcome =
          err instanceof Error && err.name === 'TimeoutError' ? 'TIMED_OUT' : 'FAILED';
        supplierOutcomes.push({ supplier: supplierName, outcome });
        logger?.error(
          { supplier: supplierName, correlationId, outcome },
          'Supplier call failed during hotel fan-out',
        );
      }
    }

    const offers = normaliser.normalise(rawOffers) as Offer[];
    return { offers, supplierOutcomes };
  }

  async function search(
    request: HotelSearchRequest,
    correlationId: string,
    preferences: MemberPreferences = {},
  ): Promise<HotelSearchResult> {
    const cacheParams = request as unknown as Record<string, unknown>;

    const cacheHit = await cacheRepository.getWithRefresh(
      'hotel',
      cacheParams,
      backgroundRefresh,
      correlationId,
    );

    if (cacheHit !== null) {
      const normalised = normaliser.normalise(cacheHit.payload.offers) as Offer[];
      const ranked = ranker.rank(normalised, preferences);
      return {
        offers: ranked,
        supplierOutcomes: cacheHit.payload.supplierOutcomes.map((o) => ({
          supplier: o.supplier,
          outcome: o.outcome as SupplierCallOutcome,
        })),
        freshness: { generatedAt: cacheHit.generatedAt, stale: cacheHit.stale },
      };
    }

    const generatedAt = new Date(clock.now());
    const { offers, supplierOutcomes } = await fanOutAndNormalise(request, correlationId);

    const allUnavailable =
      supplierOutcomes.length > 0 &&
      supplierOutcomes.every((o) => o.outcome !== 'SUCCEEDED');

    await cacheRepository.set('hotel', cacheParams, {
      schemaVersion: 1,
      generatedAt: generatedAt.getTime(),
      offers: offers.map((o) => o as unknown as Record<string, unknown>),
      supplierOutcomes,
    });

    const ranked = ranker.rank(offers, preferences);

    if (ranked.length === 0 && allUnavailable) {
      const altStayDates = computeAlternativeStayDates(
        request.checkInDate,
        request.checkOutDate,
        alternativeStayOffsetDays,
        clock.now(),
      );
      return {
        offers: [],
        supplierOutcomes,
        freshness: { generatedAt, stale: false },
        emptyState: {
          reason: 'No availability found for the requested destination and dates.',
          alternativeStayDates: altStayDates,
        },
      };
    }

    return { offers: ranked, supplierOutcomes, freshness: { generatedAt, stale: false } };
  }

  return { search };
}
