/**
 * Offer bookability guard.
 *
 * Determines whether an offer can initiate a checkout, deriving a typed
 * BookabilityState so the UI can render the correct label and gate the
 * book action structurally rather than through styling.
 *
 * Rules (from the contracts OfferSchema superRefine):
 *  - An offer with provenance "ILLUSTRATIVE" is NEVER bookable, regardless
 *    of the bookable flag.
 *  - An offer whose expiresAt is in the past is EXPIRED and cannot be booked.
 *  - Only an offer that passes both guards produces bookable: true.
 *
 * This module is a pure function — no React, no DOM, safe in any environment.
 */

import type { Offer } from "@travel/contracts/search";
import type { BookabilityState } from "../types/index.js";

/**
 * Derive the bookability state for a single offer.
 *
 * Callers pass this result to OfferCard so the component can gate the
 * "Book" action structurally — an ILLUSTRATIVE offer is unpurchasable as
 * a structural consequence of this function, not a styling choice.
 */
export function getBookabilityState(
  offer: Offer,
  now: Date = new Date()
): BookabilityState {
  // Structural non-bookability: provenance takes precedence over all flags.
  if (offer.provenance === "ILLUSTRATIVE") {
    return { bookable: false, reason: "ILLUSTRATIVE" };
  }

  // Temporal non-bookability: offer has expired.
  if (offer.expiresAt <= now) {
    return { bookable: false, reason: "EXPIRED" };
  }

  // The offer is bookable (the contracts OfferSchema already enforces that
  // bookable === true for AMADEUS / RAPIDAPI provenance, but we re-check
  // here as a structural guard in the UI layer).
  if (!offer.bookable) {
    return { bookable: false, reason: "EXPIRED" };
  }

  return { bookable: true };
}

/**
 * Returns true only when a checkout intent may be issued.
 * Use this to disable the "Book" button and suppress the checkout route.
 */
export function canInitiateCheckout(offer: Offer, now: Date = new Date()): boolean {
  return getBookabilityState(offer, now).bookable;
}

/**
 * Returns the freshness label string suitable for rendering next to a price.
 * "STALE" offers show a refresh affordance; "FRESH" offers show nothing.
 */
export function getFreshnessLabel(offer: Offer): string {
  return offer.freshness === "STALE" ? "Prices may have changed — refresh to confirm" : "";
}
