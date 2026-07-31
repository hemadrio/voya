/**
 * OfferResolutionService — resolves a cached offer by its deterministic ID.
 *
 * Outcomes:
 *   FRESH      — offer exists and is within the freshness window.
 *   STALE      — offer exists but past freshness window (within TTL); price
 *                re-validation required before checkout (BR-05).
 *   EXPIRED    — offer's expiresAt has passed; the booking flow must restart.
 *   NOT_FOUND  — no secondary index entry for this id (never issued or evicted).
 *
 * Design constraints:
 *   - Never re-queries suppliers; resolves from the offer secondary index only.
 *   - Illustrative offers (provenance ILLUSTRATIVE) resolve with bookable false.
 *   - Clock is injected for deterministic expiry testing.
 *   - Redis errors return NOT_FOUND — never propagate as 500.
 */

import type { OfferIndexEntry } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OfferResolutionOutcome = 'FRESH' | 'STALE' | 'EXPIRED' | 'NOT_FOUND';

export interface OfferFreshness {
  readonly generatedAt: Date;
  readonly stale: boolean;
  readonly expiresAt: Date;
  readonly requiresRevalidation: boolean;
}

export interface OfferResolutionResult {
  readonly outcome: OfferResolutionOutcome;
  readonly offer?: Record<string, unknown>;
  readonly freshness?: OfferFreshness;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface OfferStore {
  getOfferById(id: string): Promise<OfferIndexEntry | null>;
}

export interface OfferResolutionServiceDeps {
  offerStore: OfferStore;
  clock?: { now(): number };
  /** Window in ms before expiresAt within which requiresRevalidation is forced true. Default 300_000 (5 min). */
  revalidationWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface IOfferResolutionService {
  resolve(id: string): Promise<OfferResolutionResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOfferResolutionService(
  deps: OfferResolutionServiceDeps,
): IOfferResolutionService {
  const { offerStore, revalidationWindowMs = 5 * 60 * 1000 } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };

  async function resolve(id: string): Promise<OfferResolutionResult> {
    const entry = await offerStore.getOfferById(id);

    if (entry === null) {
      return { outcome: 'NOT_FOUND' };
    }

    const nowMs = clock.now();
    const offer = entry.offer;

    // Resolve expiresAt from the offer object (may be ISO string or Date).
    const rawExpiresAt = offer['expiresAt'];
    const expiresAt =
      rawExpiresAt instanceof Date
        ? rawExpiresAt
        : typeof rawExpiresAt === 'string'
          ? new Date(rawExpiresAt)
          : typeof rawExpiresAt === 'number'
            ? new Date(rawExpiresAt)
            : null;

    if (expiresAt === null || isNaN(expiresAt.getTime())) {
      // Treat missing/unparseable expiresAt as expired.
      return { outcome: 'EXPIRED' };
    }

    if (expiresAt.getTime() <= nowMs) {
      return { outcome: 'EXPIRED' };
    }

    const stale = nowMs > entry.freshUntil;
    const requiresRevalidation = stale || (expiresAt.getTime() - nowMs) < revalidationWindowMs;

    const freshness: OfferFreshness = {
      generatedAt: new Date(entry.generatedAt),
      stale,
      expiresAt,
      requiresRevalidation,
    };

    return {
      outcome: stale ? 'STALE' : 'FRESH',
      offer,
      freshness,
    };
  }

  return { resolve };
}
