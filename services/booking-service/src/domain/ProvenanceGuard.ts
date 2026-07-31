/**
 * ProvenanceGuard — enforces that only offers from approved supplier channels
 * may advance to a PENDING booking.
 *
 * Raises `offerNotBookable` (422) when:
 *   • provenance is "ILLUSTRATIVE" (AI-generated placeholder inventory)
 *   • provenance is an unrecognised string not in SUPPLIER_PROVENANCES
 *   • bookable flag is explicitly false
 *
 * Pure function — no I/O, fully testable without infrastructure.
 */

import { isSupplierProvenance } from "@travel/contracts/booking";
import { offerNotBookable } from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";

export interface BookableOffer {
  /** Supplier channel identifier stored on the offer / search result. */
  provenance: string;
  /** Flag set by the ingestion pipeline when the offer was obtained from a
   *  real supplier and is currently purchasable. */
  bookable: boolean;
}

/**
 * Assert that `offer` may proceed to a booking.
 *
 * @throws {DomainError} OFFER_NOT_BOOKABLE (422) when the offer is not bookable.
 */
export function assertBookable(offer: BookableOffer): void {
  if (!isSupplierProvenance(offer.provenance)) {
    throw offerNotBookable(
      `Offer provenance "${offer.provenance}" is not an approved supplier channel.`,
      "provenance",
    );
  }

  if (!offer.bookable) {
    throw offerNotBookable(
      `Offer with provenance "${offer.provenance}" is marked non-bookable.`,
      "bookable",
    );
  }
}

/**
 * Non-throwing variant — returns a `DomainError` when the offer fails the
 * guard, or `null` when it passes.  Useful in validation pipelines that
 * accumulate multiple errors before responding.
 */
export function checkBookable(offer: BookableOffer): DomainError | null {
  try {
    assertBookable(offer);
    return null;
  } catch (err) {
    return err as DomainError;
  }
}
