/**
 * FlightSearchService — orchestrates cache probe, supplier fan-out, normalisation,
 * and ranking for flight searches.
 *
 * Pipeline:
 *  1. Probe cache — fresh hit returns immediately.
 *  2. Stale hit — serve immediately + schedule background refresh.
 *  3. Cache miss — parallel supplier fan-out via injected SupplierPort adapters.
 *  4. Normalise raw offers through OfferNormaliser (validates schema, drops expired).
 *  5. Rank via OfferRanker with optional member preferences.
 *  6. Write result to cache.
 *  7. If all suppliers failed, return empty-state with alternative dates.
 *
 * No business logic lives in the route or controller layer (WO-034 constraint).
 * All I/O dependencies are injected at construction time for testability.
 */

import type { Offer } from '@travel/contracts';
import type { FlightSearchRequest } from '@travel/contracts';
import type { SupplierPort, SearchCriteria } from '@travel/supplier-port';
import type { OfferNormaliser, OfferRanker, RankedOffer, MemberPreferences } from '@travel/offer-normaliser';
import type { SearchCacheRepository } from '@travel/search-cache';
import type { CachedSearchPayload } from '@travel/search-cache';
import { computeAlternativeDates } from './alternativeDates.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupplierCallOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_CIRCUIT_OPEN';

export interface SupplierOutcomeEntry {
  readonly supplier: string;
  readonly outcome: SupplierCallOutcome;
}

export interface FlightSearchFreshness {
  readonly generatedAt: Date;
  readonly stale: boolean;
}

export interface FlightSearchEmptyState {
  readonly reason: string;
  readonly alternativeDates: string[];
}

export interface FlightSearchResult {
  readonly offers: RankedOffer[];
  readonly supplierOutcomes: SupplierOutcomeEntry[];
  readonly freshness: FlightSearchFreshness;
  readonly emptyState?: FlightSearchEmptyState;
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface FlightSearchServiceDeps {
  /** Supplier adapters — called in parallel for every cache miss. */
  suppliers: SupplierPort[];
  /** Cache repository — probed before any supplier call. */
  cacheRepository: SearchCacheRepository;
  /** Offer validator + expiry filter. */
  normaliser: OfferNormaliser;
  /** Preference-aware ranker. */
  ranker: OfferRanker;
  /**
   * Optional clock for deterministic test control.
   * Defaults to Date.now().
   */
  clock?: { now(): number };
  /** Optional logger — must never log offer payloads or credentials. */
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  /**
   * Number of days on each side of the departure date to include as
   * alternative-date suggestions in the empty state.  Defaults to 3.
   */
  alternativeDateOffsetDays?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface IFlightSearchService {
  search(
    request: FlightSearchRequest,
    correlationId: string,
    preferences?: MemberPreferences,
  ): Promise<FlightSearchResult>;
}

export function createFlightSearchService(deps: FlightSearchServiceDeps): IFlightSearchService {
  const {
    suppliers,
    cacheRepository,
    normaliser,
    ranker,
    alternativeDateOffsetDays = 3,
  } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const logger = deps.logger;

  // ---------------------------------------------------------------------------
  // Background refresh function passed to getWithRefresh
  // ---------------------------------------------------------------------------

  async function backgroundRefresh(
    _category: string,
    params: Record<string, unknown>,
    correlationId: string,
  ): Promise<CachedSearchPayload> {
    const request = params as FlightSearchRequest;
    const { offers, supplierOutcomes } = await fanOutAndNormalise(request, correlationId);

    return {
      schemaVersion: 1,
      generatedAt: clock.now(),
      offers: offers.map((o) => o as Record<string, unknown>),
      supplierOutcomes,
    };
  }

  // ---------------------------------------------------------------------------
  // Parallel supplier fan-out
  // ---------------------------------------------------------------------------

  async function fanOutAndNormalise(
    request: FlightSearchRequest,
    correlationId: string,
  ): Promise<{ offers: Offer[]; supplierOutcomes: SupplierOutcomeEntry[] }> {
    const criteria: SearchCriteria = { ...request, kind: 'flight' as const };

    const results = await Promise.allSettled(
      suppliers.map((adapter) =>
        adapter.searchOffers(criteria, correlationId),
      ),
    );

    const rawOffers: unknown[] = [];
    const supplierOutcomes: SupplierOutcomeEntry[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const supplierName = suppliers[i]!.supplierName;

      if (result.status === 'fulfilled') {
        supplierOutcomes.push({ supplier: supplierName, outcome: 'SUCCEEDED' });
        for (const offer of result.value) {
          rawOffers.push(offer);
        }
      } else {
        const err = result.reason as unknown;
        let outcome: SupplierCallOutcome = 'FAILED';
        if (err instanceof Error && err.name === 'TimeoutError') {
          outcome = 'TIMED_OUT';
        }
        supplierOutcomes.push({ supplier: supplierName, outcome });
        logger?.error(
          { supplier: supplierName, correlationId, outcome },
          'Supplier call failed during fan-out',
        );
      }
    }

    const offers = normaliser.normalise(rawOffers) as Offer[];
    return { offers, supplierOutcomes };
  }

  // ---------------------------------------------------------------------------
  // Main search method
  // ---------------------------------------------------------------------------

  async function search(
    request: FlightSearchRequest,
    correlationId: string,
    preferences: MemberPreferences = {},
  ): Promise<FlightSearchResult> {
    const cacheParams = request as unknown as Record<string, unknown>;

    // 1. Probe cache with background refresh hook.
    const cacheHit = await cacheRepository.getWithRefresh(
      'flight',
      cacheParams,
      backgroundRefresh,
      correlationId,
    );

    if (cacheHit !== null) {
      // Cache hit (fresh or stale-served)
      const rawOffers = cacheHit.payload.offers;
      const normalised = normaliser.normalise(rawOffers) as Offer[];
      const ranked = ranker.rank(normalised, preferences);

      return {
        offers: ranked,
        supplierOutcomes: cacheHit.payload.supplierOutcomes.map((o) => ({
          supplier: o.supplier,
          outcome: o.outcome as SupplierCallOutcome,
        })),
        freshness: {
          generatedAt: cacheHit.generatedAt,
          stale: cacheHit.stale,
        },
      };
    }

    // 2. Cache miss — fan out to suppliers.
    const generatedAt = new Date(clock.now());
    const { offers, supplierOutcomes } = await fanOutAndNormalise(request, correlationId);

    // 3. Write to cache (best-effort, errors silently absorbed by repository).
    const allUnavailable = supplierOutcomes.length > 0 &&
      supplierOutcomes.every((o) => o.outcome !== 'SUCCEEDED');

    await cacheRepository.set('flight', cacheParams, {
      schemaVersion: 1,
      generatedAt: generatedAt.getTime(),
      offers: offers.map((o) => o as unknown as Record<string, unknown>),
      supplierOutcomes,
    });

    // 4. Rank.
    const ranked = ranker.rank(offers, preferences);

    // 5. Empty state — no offers and all suppliers failed/skipped.
    if (ranked.length === 0 && allUnavailable) {
      // request.departureDate is a Date after Zod parsing; convert to YYYY-MM-DD string
      // for the deterministic offset computation.
      const departureDateStr = request.departureDate instanceof Date
        ? request.departureDate.toISOString().slice(0, 10)
        : String(request.departureDate);
      const alternativeDates = computeAlternativeDates(
        departureDateStr,
        alternativeDateOffsetDays,
        clock.now(),
      );

      return {
        offers: [],
        supplierOutcomes,
        freshness: { generatedAt, stale: false },
        emptyState: {
          reason: 'No availability found for the requested route and date.',
          alternativeDates,
        },
      };
    }

    // 6. Partial or full success — return offers with attributed outcomes.
    return {
      offers: ranked,
      supplierOutcomes,
      freshness: { generatedAt, stale: false },
    };
  }

  return { search };
}
