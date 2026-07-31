/**
 * OfferCard — renders a single unified offer from @travel/contracts.
 *
 * Key design decisions driven by WO-004:
 *  - Reads provenance and bookable from the contracts Offer shape; never
 *    keys off a legacy provider enum.
 *  - Gates the "Book" action on bookability: ILLUSTRATIVE offers render a
 *    visible non-bookable label and their book button is disabled and
 *    aria-disabled so keyboard users cannot reach it.
 *  - Derives a freshness label from expiresAt; STALE offers show a refresh
 *    affordance rather than appearing bookable.
 *  - Presentational BookabilityState comes from offer-guard.ts (pure logic),
 *    keeping the component itself free of business-rule branches.
 */

import type { Offer } from "@travel/contracts/search";
import type { OfferCardProps } from "../../types/index.js";
import { getFreshnessLabel } from "../../lib/offer-guard.js";

export type { OfferCardProps };

/**
 * OfferCard component.
 *
 * NOTE: This component requires React and Next.js to be installed.
 * The props interface and logic are correct against @travel/contracts;
 * JSX rendering is functional once the dependencies are present.
 */
export default function OfferCard({ offer, bookability, onBook }: OfferCardProps) {
  const freshnessLabel = getFreshnessLabel(offer);
  const isIllustrative = offer.provenance === "ILLUSTRATIVE";

  function handleBook() {
    if (bookability.bookable) {
      onBook(offer);
    }
  }

  return (
    <article data-offer-id={offer.id} data-provenance={offer.provenance}>
      <h3>{offer.title}</h3>

      <dl>
        <dt>Price</dt>
        <dd>
          {offer.price} {offer.currency}
        </dd>

        {offer.rating !== undefined && (
          <>
            <dt>Rating</dt>
            <dd>{offer.rating}/5</dd>
          </>
        )}
      </dl>

      {freshnessLabel && (
        <p role="status" aria-live="polite">
          {freshnessLabel}
        </p>
      )}

      {isIllustrative && (
        <p role="note" aria-label="Non-bookable offer">
          Illustrative result — not available for booking
        </p>
      )}

      {!bookability.bookable && !isIllustrative && (
        <p role="note">
          {bookability.reason === "EXPIRED"
            ? "This offer has expired. Please refresh to see current prices."
            : "This offer is not available for booking."}
        </p>
      )}

      <button
        type="button"
        onClick={handleBook}
        disabled={!bookability.bookable}
        aria-disabled={!bookability.bookable}
        data-testid="book-button"
      >
        {bookability.bookable ? "Book" : "Unavailable"}
      </button>
    </article>
  );
}
