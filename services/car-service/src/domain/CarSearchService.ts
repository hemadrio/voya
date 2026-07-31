/**
 * CarSearchService — orchestrates cache probe, supplier fan-out, normalisation,
 * and ranking for car rental searches.
 *
 * Pipeline:
 *  1. Probe cache using time-bucketed params — fresh hit returns immediately.
 *  2. Stale hit — serve immediately with background refresh.
 *  3. Cache miss — parallel supplier fan-out via injected SupplierPort adapters.
 *  4. Normalise raw offers through OfferNormaliser.
 *  5. Rank via OfferRanker with optional car-class preference (preference only, no filtering).
 *  6. Write result to cache with bucketed params.
 *  7. If all suppliers failed, return empty-state with alternative pickup windows.
 *
 * Cache key time bucketing:
 *   pickup and dropoff dates are rounded down to the nearest timeBucketMinutes
 *   boundary before use as cache params. Searches within the same bucket share
 *   a key (intentional). Searches across bucket boundaries get distinct keys (AC6).
 *
 * UNKNOWN vehicle class:
 *   Offers with vehicleClass UNKNOWN pass through normalisation and ranking unchanged.
 *   They are never filtered out (AC5). A warn-level log fires for each UNKNOWN offer
 *   so the mapping table can be extended operationally.
 */

import type { Offer } from '@travel/contracts';
import type { CarRentalSearchRequest } from '@travel/contracts';
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

export interface CarSearchFreshness {
  readonly generatedAt: Date;
  readonly stale: boolean;
}

export interface AlternativePickupWindow {
  readonly pickupDate: string;
  readonly dropoffDate: string;
}

export interface CarSearchEmptyState {
  readonly reason: string;
  readonly alternativePickupWindows: AlternativePickupWindow[];
}

export interface CarSearchResult {
  readonly offers: RankedOffer[];
  readonly supplierOutcomes: SupplierOutcomeEntry[];
  readonly freshness: CarSearchFreshness;
  readonly emptyState?: CarSearchEmptyState;
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface CarSearchServiceDeps {
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
  alternativeWindowOffsetDays?: number;
  timeBucketMinutes?: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ICarSearchService {
  search(
    request: CarRentalSearchRequest,
    correlationId: string,
    preferences?: MemberPreferences,
  ): Promise<CarSearchResult>;
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

/**
 * Round a date down to the nearest timeBucketMinutes boundary.
 * Used to build cache params so near-identical searches share a key.
 */
export function roundToTimeBucket(date: Date, granularityMinutes: number): Date {
  const ms = granularityMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

// ---------------------------------------------------------------------------
// Alternative pickup window computation
// ---------------------------------------------------------------------------

function computeAlternativePickupWindows(
  pickupDate: Date | string,
  dropoffDate: Date | string,
  offsetDays: number,
  nowMs: number,
): AlternativePickupWindow[] {
  const pickup = pickupDate instanceof Date ? pickupDate : new Date(String(pickupDate));
  const dropoff = dropoffDate instanceof Date ? dropoffDate : new Date(String(dropoffDate));
  const rentalMs = dropoff.getTime() - pickup.getTime();

  if (rentalMs <= 0) return [];

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const todayStartMs = new Date(nowMs).setUTCHours(0, 0, 0, 0);
  const results: AlternativePickupWindow[] = [];

  for (let offset = -offsetDays; offset <= offsetDays; offset++) {
    if (offset === 0) continue;

    const altPickupMs = pickup.getTime() + offset * ONE_DAY_MS;
    if (altPickupMs <= todayStartMs) continue;

    const altPickup = new Date(altPickupMs);
    const altDropoff = new Date(altPickupMs + rentalMs);

    results.push({
      pickupDate: altPickup.toISOString(),
      dropoffDate: altDropoff.toISOString(),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCarSearchService(deps: CarSearchServiceDeps): ICarSearchService {
  const {
    suppliers,
    cacheRepository,
    normaliser,
    ranker,
    alternativeWindowOffsetDays = 3,
    timeBucketMinutes = 15,
  } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const logger = deps.logger;

  function buildBucketedParams(request: CarRentalSearchRequest): Record<string, unknown> {
    const pickupDate = request.pickupDate instanceof Date
      ? request.pickupDate
      : new Date(String(request.pickupDate));
    const dropoffDate = request.dropoffDate instanceof Date
      ? request.dropoffDate
      : new Date(String(request.dropoffDate));

    return {
      ...request,
      pickupDate: roundToTimeBucket(pickupDate, timeBucketMinutes).toISOString(),
      dropoffDate: roundToTimeBucket(dropoffDate, timeBucketMinutes).toISOString(),
    };
  }

  async function backgroundRefresh(
    _category: string,
    params: Record<string, unknown>,
    correlationId: string,
  ): Promise<CachedSearchPayload> {
    const request = params as CarRentalSearchRequest;
    const { offers, supplierOutcomes } = await fanOutAndNormalise(request, correlationId);
    return {
      schemaVersion: 1,
      generatedAt: clock.now(),
      offers: offers.map((o) => o as unknown as Record<string, unknown>),
      supplierOutcomes,
    };
  }

  async function fanOutAndNormalise(
    request: CarRentalSearchRequest,
    correlationId: string,
  ): Promise<{ offers: Offer[]; supplierOutcomes: SupplierOutcomeEntry[] }> {
    const criteria: SearchCriteria = { ...request, kind: 'car' as const };

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
        for (const offer of result.value) {
          const details = (offer as { details?: Record<string, unknown> }).details ?? {};
          if (details['vehicleClass'] === 'UNKNOWN') {
            logger?.warn(
              { supplier: supplierName, vehicleId: details['vehicleId'], correlationId },
              'Unmapped vehicle class returned as UNKNOWN',
            );
          }
          rawOffers.push(offer);
        }
      } else {
        const err = result.reason as unknown;
        const outcome: SupplierCallOutcome =
          err instanceof Error && err.name === 'TimeoutError' ? 'TIMED_OUT' : 'FAILED';
        supplierOutcomes.push({ supplier: supplierName, outcome });
        logger?.error(
          { supplier: supplierName, correlationId, outcome },
          'Supplier call failed during car fan-out',
        );
      }
    }

    const offers = normaliser.normalise(rawOffers) as Offer[];
    return { offers, supplierOutcomes };
  }

  async function search(
    request: CarRentalSearchRequest,
    correlationId: string,
    preferences: MemberPreferences = {},
  ): Promise<CarSearchResult> {
    const cacheParams = buildBucketedParams(request);

    const cacheHit = await cacheRepository.getWithRefresh(
      'car',
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

    await cacheRepository.set('car', cacheParams, {
      schemaVersion: 1,
      generatedAt: generatedAt.getTime(),
      offers: offers.map((o) => o as unknown as Record<string, unknown>),
      supplierOutcomes,
    });

    const ranked = ranker.rank(offers, preferences);

    if (ranked.length === 0 && allUnavailable) {
      const altWindows = computeAlternativePickupWindows(
        request.pickupDate,
        request.dropoffDate,
        alternativeWindowOffsetDays,
        clock.now(),
      );
      return {
        offers: [],
        supplierOutcomes,
        freshness: { generatedAt, stale: false },
        emptyState: {
          reason: 'No car rental availability found for the requested location and dates.',
          alternativePickupWindows: altWindows,
        },
      };
    }

    return { offers: ranked, supplierOutcomes, freshness: { generatedAt, stale: false } };
  }

  return { search };
}
