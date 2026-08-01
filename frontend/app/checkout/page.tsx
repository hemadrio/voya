/**
 * Checkout page — App Router Server Component.
 *
 * All request/response types are imported from @travel/contracts.
 * No local shape is declared for any platform payload.
 *
 * IMPORTANT: Checkout entry is gated on offer.bookable AND
 * offer.provenance !== "ILLUSTRATIVE".  An offer that fails either
 * condition must never reach this page — the search page and OfferCard
 * structurally prevent the route from being reached.
 *
 * WO-071: Pricing and checkout responses must never be cached.
 * This directive, combined with Cache-Control: no-store headers in next.config.js,
 * ensures checkout data is always fetched fresh from the origin.
 */

// Explicitly opt out of Next.js data cache for pricing / checkout data (WO-071 AC5).
export const dynamic = "force-dynamic";

import type { CreateBookingRequest, BookingResponse } from "@travel/contracts/booking";
import type { Offer } from "@travel/contracts/search";
import type { ErrorEnvelope } from "@travel/contracts/errors";
import type { ApiResult } from "../../types/index.js";
import { canInitiateCheckout } from "../../lib/offer-guard.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface CheckoutPageSearchParams {
  offerId: string;
}

export interface CheckoutPageProps {
  searchParams: CheckoutPageSearchParams;
}

// ---------------------------------------------------------------------------
// Checkout guard — throws a typed error when the offer is non-bookable
// ---------------------------------------------------------------------------

export class NonBookableOfferError extends Error {
  constructor(offerId: string, reason: "ILLUSTRATIVE" | "EXPIRED" | "FLAG_FALSE") {
    super(
      `Offer ${offerId} cannot be checked out: ${reason}. ` +
        "Only real-supplier, non-expired offers may initiate a booking."
    );
    this.name = "NonBookableOfferError";
  }
}

/**
 * Assert that the offer can initiate a checkout.
 * Throws NonBookableOfferError if it cannot.
 *
 * Called by the page before issuing a CreateBookingRequest so that
 * illustrative offers can never reach the booking service.
 */
export function assertBookable(offer: Offer): void {
  if (offer.provenance === "ILLUSTRATIVE") {
    throw new NonBookableOfferError(offer.id, "ILLUSTRATIVE");
  }
  if (!canInitiateCheckout(offer)) {
    throw new NonBookableOfferError(offer.id, offer.bookable ? "EXPIRED" : "FLAG_FALSE");
  }
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

/**
 * Build a CreateBookingRequest from a validated offer and passenger data.
 * The offer price and currency are snapshotted at selection time so
 * price re-consent is detectable by the booking service (BR-05).
 */
export function buildCreateBookingRequest(
  offer: Offer,
  passengers: CreateBookingRequest["passengers"],
  contactEmail: string,
  idempotencyKey: string
): CreateBookingRequest {
  assertBookable(offer);

  return {
    bookingType: "FLIGHT",
    offerId: offer.id,
    offerPrice: offer.price,
    currency: offer.currency,
    passengers,
    contactEmail,
    idempotencyKey,
  };
}

import { Suspense } from "react";
import { CheckoutWizard } from "../../components/checkout/CheckoutWizard.js";

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function CheckoutPage(_props: CheckoutPageProps) {
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <h1 className="sr-only">Checkout</h1>
      {/* CheckoutWizard is a client component — Suspense handles the initial render */}
      <Suspense fallback={
        <div
          className="flex flex-col items-center gap-3 py-16 text-sm text-neutral-500"
          role="status"
          aria-live="polite"
        >
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
            aria-hidden="true"
          />
          Loading checkout…
        </div>
      }>
        <CheckoutWizard />
      </Suspense>
    </main>
  );
}
