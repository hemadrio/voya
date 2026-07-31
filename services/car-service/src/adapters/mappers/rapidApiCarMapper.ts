/**
 * rapidApiCarMapper — translates RapidAPI car rental search responses into the
 * port-neutral Offer shape from @travel/contracts.
 *
 * All RapidAPI car-specific quirks (free-form vehicle descriptions, daily-rate-
 * only pricing, provider SIPP codes) are absorbed here so downstream code
 * (normaliser, cache, controllers) remains provider-agnostic.
 *
 * Deterministic offer ID:
 *   sha256("RAPIDAPI-CAR:" + vehicleId + ":" + searchFingerprint)
 *   Stable across identical searches — enables GET /v1/offers/{id} resolution.
 */

import { createHash } from 'node:crypto';
import type { Offer } from '@travel/contracts';
import type { CarSearchCriteria } from '@travel/supplier-port';
import { mapVehicleClass } from './vehicleClassMap.js';

// ---------------------------------------------------------------------------
// RapidAPI car response shape (local types — never exported)
// ---------------------------------------------------------------------------

interface RapidApiVehicle {
  vehicle_id?: string | number;
  vehicle_name?: string;
  name?: string;
  vehicle_category?: string;
  category?: string;
  sipp_code?: string;
  /** Total price for the full rental period (preferred). */
  total_price?: number | string | null;
  /** Daily/nightly rate — used to derive total when total is absent. */
  price_per_day?: number | string | null;
  daily_rate?: number | string | null;
  currency?: string;
  /** Pickup and drop-off identifiers (airport code, address, or location ID). */
  pickup_location?: string;
  dropoff_location?: string;
}

export interface RapidApiCarSearchResponse {
  search_results?: unknown[];
  results?: unknown[];
}

// ---------------------------------------------------------------------------
// Return type (offers + unmapped class descriptions for caller logging)
// ---------------------------------------------------------------------------

export interface CarMapperResult {
  offers: ReadonlyArray<Offer>;
  /** Raw provider descriptions that could not be mapped to a canonical class. */
  unmappedDescriptions: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute rental duration in whole days.
 * Uses Math.ceil so a 36-hour rental counts as 2 days, matching most
 * provider billing conventions. Minimum 1 day to prevent divide-by-zero.
 */
export function computeRentalDays(pickupDate: Date, dropoffDate: Date): number {
  const ms = dropoffDate.getTime() - pickupDate.getTime();
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Build a 16-character deterministic search fingerprint from the car criteria.
 * Used only as part of the deterministic offer ID — not a security primitive.
 */
export function buildCarSearchFingerprint(criteria: CarSearchCriteria): string {
  const pickup =
    criteria.pickupDate instanceof Date
      ? criteria.pickupDate.toISOString().slice(0, 10)
      : String(criteria.pickupDate).slice(0, 10);
  const dropoff =
    criteria.dropoffDate instanceof Date
      ? criteria.dropoffDate.toISOString().slice(0, 10)
      : String(criteria.dropoffDate).slice(0, 10);
  const key = [
    criteria.pickupLocation,
    criteria.dropoffLocation,
    pickup,
    dropoff,
    criteria.carClass,
    criteria.currency,
  ].join(':');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function makeOfferId(vehicleId: string, fingerprint: string): string {
  return createHash('sha256')
    .update(`RAPIDAPI-CAR:${vehicleId}:${fingerprint}`)
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
 * Map a RapidAPI car rental search response to platform Offer objects.
 *
 * @param response - Parsed RapidAPI response body.
 * @param criteria - Original search criteria (for fingerprint and day count).
 * @param defaultValidityMinutes - Validity window when the provider omits an expiry.
 * @param now - Current timestamp (injectable for deterministic tests).
 * @returns offers array plus any unmapped vehicle class descriptions (for caller logging).
 */
export function mapRapidApiCarOffers(
  response: RapidApiCarSearchResponse,
  criteria: CarSearchCriteria,
  defaultValidityMinutes: number,
  now: Date,
): CarMapperResult {
  const vehicles = (response.search_results ?? response.results ?? []) as RapidApiVehicle[];
  const fingerprint = buildCarSearchFingerprint(criteria);
  const expiresAt = new Date(now.getTime() + defaultValidityMinutes * 60_000);

  const pickupDate =
    criteria.pickupDate instanceof Date
      ? criteria.pickupDate
      : new Date(String(criteria.pickupDate));
  const dropoffDate =
    criteria.dropoffDate instanceof Date
      ? criteria.dropoffDate
      : new Date(String(criteria.dropoffDate));
  const rentalDays = computeRentalDays(pickupDate, dropoffDate);

  const unmappedDescriptions: string[] = [];

  const offers = vehicles.map((raw): Offer => {
    const vehicleId = String(raw.vehicle_id ?? 'unknown');
    const vehicleName = (raw.vehicle_name ?? raw.name ?? 'Rental Vehicle').trim() || 'Rental Vehicle';
    const rawCategory = raw.vehicle_category ?? raw.category ?? vehicleName;
    const vehicleClass = mapVehicleClass(rawCategory);

    if (vehicleClass === 'UNKNOWN') {
      unmappedDescriptions.push(rawCategory);
    }

    const currency = ((raw.currency ?? criteria.currency) || 'USD').trim().toUpperCase();

    // Resolve total price.  Prefer the explicit total; derive from daily rate
    // when only a per-day rate is supplied.
    const totalPriceRaw = parsePrice(raw.total_price);
    const dailyRateRaw = parsePrice(raw.price_per_day ?? raw.daily_rate);

    /**
     * Total price derivation from daily rate:
     *   totalPrice = Math.round(dailyRate * rentalDays * 100) / 100
     *
     * rentalDays = Math.ceil((dropoffDate − pickupDate) / MS_PER_DAY), minimum 1.
     * Rounds to 2 decimal places (≤ 2 dp required by the positiveMoney constraint).
     * The same dailyRate + rentalDays always produces the same totalPrice (deterministic).
     */
    const totalPrice =
      totalPriceRaw ??
      (dailyRateRaw !== null ? Math.round(dailyRateRaw * rentalDays * 100) / 100 : 0);

    /**
     * Daily rate derivation from total price:
     *   dailyRate = Math.round((totalPrice / rentalDays) * 100) / 100
     */
    const dailyRate =
      dailyRateRaw ??
      (totalPriceRaw !== null
        ? Math.round((totalPriceRaw / rentalDays) * 100) / 100
        : null);

    const details: Record<string, unknown> = {
      supplier: 'RAPIDAPI',
      vehicleClass,
      vehicleId,
      pickupLocation: raw.pickup_location ?? criteria.pickupLocation,
      dropoffLocation: raw.dropoff_location ?? criteria.dropoffLocation,
      totalPrice,
      rentalDays,
    };
    if (dailyRate !== null) details['dailyRate'] = dailyRate;
    if (raw.sipp_code !== undefined) details['sippCode'] = raw.sipp_code;

    return {
      id: makeOfferId(vehicleId, fingerprint),
      provenance: 'RAPIDAPI',
      bookable: true,
      title: vehicleName,
      price: totalPrice,
      currency,
      details,
      expiresAt,
      freshness: 'FRESH',
    };
  });

  return { offers, unmappedDescriptions };
}
