/**
 * Price re-validation contract schemas (WO-042).
 *
 * POST /v1/bookings/{id}/revalidate  → RevalidateResponse
 * POST /v1/bookings/{id}/accept-price → AcceptPriceResponse
 *
 * Money rules (BR-05):
 *   - All price values carry the same `currency` field; no implicit conversion.
 *   - `acceptedTotal` in AcceptPriceRequest must be bit-exact equal to the
 *     `newTotal` returned by the preceding revalidate call (string comparison
 *     after rounding to 2 decimal places).  This prevents blind consent.
 *   - `delta` may be negative (price decreased) or zero (unchanged).
 */

import { z } from "zod";
import { identifier, currencyCode, isoDateString, positiveMoney } from "../common/primitives.js";

// ---------------------------------------------------------------------------
// Freshness label for per-leg supplier result
// ---------------------------------------------------------------------------

/**
 * Indicates how fresh the supplier price data is for a given leg.
 *   LIVE   — fetched live from the supplier within this request.
 *   CACHED — served from a valid cache window (still trusted).
 *   STALE  — served from a cache window that has passed; used as indicative
 *             only — the re-validation was performed against a stale price.
 */
export const LegFreshnessSchema = z.enum(["LIVE", "CACHED", "STALE"]);
export type LegFreshness = z.infer<typeof LegFreshnessSchema>;

// ---------------------------------------------------------------------------
// Per-leg revalidation result
// ---------------------------------------------------------------------------

export const RevalidatedLegSchema = z
  .object({
    offerId: identifier,
    supplier: z.string().min(1),
    /** Price for this leg in the booking currency. */
    price: positiveMoney,
    currency: currencyCode,
    freshness: LegFreshnessSchema,
  })
  .strict();

export type RevalidatedLeg = z.infer<typeof RevalidatedLegSchema>;

// ---------------------------------------------------------------------------
// POST /v1/bookings/{id}/revalidate — response body
// ---------------------------------------------------------------------------

export const RevalidateResponseSchema = z
  .object({
    bookingId: identifier,
    /** True when the re-validated total differs from the snapshot total. */
    priceChanged: z.boolean(),
    /** Total as recorded in the original offer snapshot (decimal string). */
    previousTotal: positiveMoney,
    /** Total returned by the supplier re-price call (decimal string). */
    newTotal: positiveMoney,
    currency: currencyCode,
    /**
     * Signed difference: newTotal - previousTotal.
     * Negative means the price dropped; zero means no change.
     */
    delta: z.number(),
    /**
     * Deadline by which the traveler must call accept-price (or re-validate).
     * Only meaningful when priceChanged=true; when false the booking is
     * immediately payable and this marks the end of the payment window.
     */
    quoteExpiresAt: isoDateString,
    legs: z.array(RevalidatedLegSchema),
    reference: identifier.optional(),
  })
  .strict();

export type RevalidateResponse = z.infer<typeof RevalidateResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/bookings/{id}/accept-price — request body
// ---------------------------------------------------------------------------

/**
 * The traveler must submit the exact `newTotal` value from the preceding
 * revalidate response.  The service rejects any mismatch — this prevents
 * a client from blindly accepting a price it did not display.
 */
export const AcceptPriceRequestSchema = z
  .object({
    acceptedTotal: positiveMoney,
    currency: currencyCode,
  })
  .strict();

export type AcceptPriceRequest = z.infer<typeof AcceptPriceRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/bookings/{id}/accept-price — response body
// ---------------------------------------------------------------------------

export const AcceptPriceResponseSchema = z
  .object({
    /** Timestamp after which the booking is no longer payable at this price. */
    payableUntil: isoDateString,
  })
  .strict();

export type AcceptPriceResponse = z.infer<typeof AcceptPriceResponseSchema>;
