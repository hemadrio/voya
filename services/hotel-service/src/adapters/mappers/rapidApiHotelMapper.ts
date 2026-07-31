/**
 * rapidApiHotelMapper — translates RapidAPI hotel search responses into the
 * port-neutral Offer shape from @travel/contracts.
 *
 * All RapidAPI-specific quirks (star-rating format variations, optional review
 * signals, total-vs-nightly price derivation) are absorbed here so downstream
 * code (normaliser, cache, controllers) remains provider-agnostic.
 *
 * Deterministic offer ID: sha256("RAPIDAPI:" + hotelId + ":" + ratePlanCode + ":" + searchFingerprint).
 * The same property/rate for the same search always produces the same platform ID,
 * enabling GET /v1/offers/{id} resolution without a lookup table.
 */

import { createHash } from 'node:crypto';
import type { Offer } from '@travel/contracts';
import type { HotelSearchCriteria } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// RapidAPI response shape (local types — never exported)
// ---------------------------------------------------------------------------

interface RapidApiProperty {
  hotel_id?: string | number;
  property_id?: string | number;
  hotel_name?: string;
  name?: string;
  class?: unknown;
  stars?: unknown;
  review_score?: number | null;
  review_nr?: number | null;
  review_count?: number | null;
  /** Total price for the full stay (preferred over nightly_price when present). */
  min_total_price?: number | string | null;
  total_price?: number | string | null;
  /** Nightly price — used only when total is absent (rare; mapped to derive total). */
  nightly_price?: number | string | null;
  currencycode?: string;
  currency?: string;
  rate_plan_code?: string;
}

export interface RapidApiHotelSearchResponse {
  result?: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the integer stay length in nights.
 * Uses Math.ceil so a 36-hour stay counts as 2 nights, matching hotel check-out
 * convention. Callers are responsible for ensuring checkOut > checkIn.
 */
export function computeNights(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Coerce a provider star rating to a numeric value in [0, 5], or null when
 * absent or unparseable.
 *
 * Supported input forms:
 *   - number    : 4, 4.5, 3 (clamped to [0, 5])
 *   - string    : "4", "4.5" (parsed then clamped)
 *   - null/undef: → null (never defaulted)
 *
 * Rule: values outside [0, 5] are clamped, not rejected. Non-numeric strings
 * and non-finite values return null. We never substitute a default value for
 * a missing or uncoerceable rating (BR-11 honesty constraint).
 */
export function coerceStarRating(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let numeric: number;
  if (typeof raw === 'number') {
    numeric = raw;
  } else if (typeof raw === 'string') {
    numeric = parseFloat(raw);
    if (isNaN(numeric)) return null;
  } else {
    return null;
  }
  if (!isFinite(numeric) || numeric < 0) return null;
  return Math.min(5, numeric);
}

/**
 * Build a 16-character deterministic search fingerprint from the hotel criteria.
 * Used only as part of the deterministic offer ID — not a security primitive.
 */
export function buildHotelSearchFingerprint(criteria: HotelSearchCriteria): string {
  const checkIn =
    criteria.checkInDate instanceof Date
      ? criteria.checkInDate.toISOString().slice(0, 10)
      : String(criteria.checkInDate).slice(0, 10);
  const checkOut =
    criteria.checkOutDate instanceof Date
      ? criteria.checkOutDate.toISOString().slice(0, 10)
      : String(criteria.checkOutDate).slice(0, 10);
  const key = [criteria.location, checkIn, checkOut, String(criteria.guests), criteria.currency].join(':');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function makeOfferId(hotelId: string, ratePlanCode: string, fingerprint: string): string {
  return createHash('sha256')
    .update(`RAPIDAPI:${hotelId}:${ratePlanCode}:${fingerprint}`)
    .digest('hex');
}

function parsePrice(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const numeric = typeof raw === 'string' ? parseFloat(raw) : raw;
  return isFinite(numeric) && numeric > 0 ? numeric : null;
}

// ---------------------------------------------------------------------------
// Mapper (exported)
// ---------------------------------------------------------------------------

/**
 * Map a RapidAPI hotel search response to platform Offer objects.
 *
 * @param response - Parsed RapidAPI response body.
 * @param criteria - Original search criteria (for fingerprint and nights computation).
 * @param defaultValidityMinutes - Validity window when the provider does not supply an expiry.
 * @param now - Current timestamp (injectable for deterministic tests).
 */
export function mapRapidApiHotelOffers(
  response: RapidApiHotelSearchResponse,
  criteria: HotelSearchCriteria,
  defaultValidityMinutes: number,
  now: Date,
): ReadonlyArray<Offer> {
  const properties = (response.result ?? []) as RapidApiProperty[];
  const fingerprint = buildHotelSearchFingerprint(criteria);

  const checkIn =
    criteria.checkInDate instanceof Date
      ? criteria.checkInDate
      : new Date(String(criteria.checkInDate));
  const checkOut =
    criteria.checkOutDate instanceof Date
      ? criteria.checkOutDate
      : new Date(String(criteria.checkOutDate));
  const nights = computeNights(checkIn, checkOut);

  const expiresAt = new Date(now.getTime() + defaultValidityMinutes * 60_000);

  return properties
    .filter((raw) => {
      const hotelId = raw.hotel_id ?? raw.property_id;
      return hotelId !== undefined && hotelId !== null && String(hotelId).length > 0;
    })
    .map((raw): Offer => {
      const hotelId = String(raw.hotel_id ?? raw.property_id ?? 'unknown');
      const hotelName = (raw.hotel_name ?? raw.name ?? 'Hotel').trim() || 'Hotel';
      const ratePlanCode = raw.rate_plan_code ?? 'default';
      const currency = (raw.currencycode ?? raw.currency ?? 'USD').trim().toUpperCase();

      // Prefer min_total_price (full stay), fall back to total_price, then derive from nightly.
      const rawTotal = raw.min_total_price ?? raw.total_price;
      const rawNightly = raw.nightly_price;
      const totalPrice =
        parsePrice(rawTotal) ??
        (parsePrice(rawNightly) !== null ? (parsePrice(rawNightly) as number) * nights : null) ??
        0;

      /**
       * Nightly price derivation:
       *   nightlyPrice = Math.round((totalPrice / nights) * 100) / 100
       *
       * Rounds to 2 decimal places to satisfy the platform positiveMoney
       * constraint (≤ 2 decimal places). The same totalPrice + nights always
       * produces the same nightlyPrice (deterministic, no randomness).
       * nights = Math.ceil((checkOut − checkIn) / 86_400_000), minimum 1.
       */
      const nightlyPrice = Math.round((totalPrice / nights) * 100) / 100;

      const starRating = coerceStarRating(raw.class ?? raw.stars);
      const reviewNr = raw.review_nr ?? raw.review_count;
      const reviewScore = raw.review_score;

      const details: Record<string, unknown> = {
        supplier: 'RAPIDAPI',
        propertyId: hotelId,
        ratePlanCode,
        totalPrice,
        nightlyPrice,
        nights,
      };
      if (reviewScore !== undefined && reviewScore !== null) {
        details['reviewScore'] = reviewScore;
      }

      const offer: Offer = {
        id: makeOfferId(hotelId, ratePlanCode, fingerprint),
        provenance: 'RAPIDAPI',
        bookable: true,
        title: hotelName,
        price: nightlyPrice,
        currency,
        details,
        expiresAt,
        freshness: 'FRESH',
        ...(starRating !== null ? { rating: starRating } : {}),
        ...(reviewNr !== undefined && reviewNr !== null ? { reviews: Math.floor(reviewNr) } : {}),
      };

      return offer;
    });
}
