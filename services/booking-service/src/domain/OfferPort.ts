/**
 * OfferPort — injectable port for resolving a normalised offer from the
 * search cache or supplier endpoint (WO-039).
 *
 * The domain layer depends only on this interface; concrete adapters
 * (Redis search-cache adapter, supplier HTTP adapter) are wired at startup.
 * Unit tests pass an in-memory fake.
 *
 * No Express, no Prisma — safe to import anywhere.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** A single leg within a multi-segment offer. */
export interface ResolvedOfferLeg {
  offerId: string;
  supplier: string;
  provenance: string;
  origin?: string;
  destination?: string;
  departureAt?: Date;
  arrivalAt?: Date;
  checkInDate?: string;
  checkOutDate?: string;
  pickUpDate?: string;
  dropOffDate?: string;
}

/**
 * Normalised offer as returned by the OfferPort.
 *
 * `totalPrice` is a number in the offer's currency (e.g. 412.50 USD).
 * The domain service serialises it to a decimal string for snapshot storage
 * so there is no floating-point arithmetic in the persistence path.
 */
export interface ResolvedOffer {
  offerId: string;
  provenance: string;
  supplier: string;
  bookable: boolean;
  totalPrice: number;
  currency: string;
  expiresAt?: Date;
  legs: ResolvedOfferLeg[];
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * Resolves a normalised offer by offer ID.
 *
 * Returns null when:
 *   - the offer ID is unknown
 *   - the offer has been evicted from the search cache
 *   - the supplier no longer has this offer
 *
 * The domain service maps null → 404 OFFER_NOT_FOUND.
 */
export interface OfferPort {
  resolveOffer(offerId: string): Promise<ResolvedOffer | null>;
}
