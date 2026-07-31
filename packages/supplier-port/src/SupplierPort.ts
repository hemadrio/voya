/**
 * SupplierPort — hexagonal-architecture port for all supplier adapters.
 *
 * All request/response types are imported directly from @travel/contracts so
 * there are zero duplicate definitions and contracts remains the single source
 * of truth.
 *
 * The SupplierFlowShape discriminant (INSTANT, RESERVE_THEN_CONFIRM, ARI_PUSH)
 * models the booking protocol, not the travel vertical.  A single adapter may
 * support multiple shapes (e.g. instant flights plus reserve/confirm hotels).
 */

import type {
  FlightSearchRequest,
  HotelSearchRequest,
  CarRentalSearchRequest,
  Offer,
} from '@travel/contracts';

// ---------------------------------------------------------------------------
// Flow shape discriminant
// ---------------------------------------------------------------------------

/**
 * The booking protocol supported by an adapter.
 *
 *  INSTANT              — search returns a directly bookable offer; a single
 *                          purchase call completes the booking.
 *  RESERVE_THEN_CONFIRM — two-step: reserve() places a hold (time-boxed), then
 *                          confirm() completes the purchase.  Non-idempotent
 *                          calls must not be retried by SupplierHttpClient.
 *  ARI_PUSH             — adapter consumes push-based Availability/Rate/Inventory
 *                          feeds; searchOffers() returns from a local cache.
 */
export type SupplierFlowShape = 'INSTANT' | 'RESERVE_THEN_CONFIRM' | 'ARI_PUSH';

// ---------------------------------------------------------------------------
// Search criteria — contracts types wrapped with a kind discriminant
// ---------------------------------------------------------------------------

/**
 * Adds a `kind` tag to the @travel/contracts FlightSearchRequest so a
 * discriminated union is possible without duplicating any field definitions.
 */
export type FlightSearchCriteria = FlightSearchRequest & { readonly kind: 'flight' };

/**
 * Adds a `kind` tag to the @travel/contracts HotelSearchRequest.
 */
export type HotelSearchCriteria = HotelSearchRequest & { readonly kind: 'hotel' };

/**
 * Adds a `kind` tag to the @travel/contracts CarRentalSearchRequest.
 */
export type CarSearchCriteria = CarRentalSearchRequest & { readonly kind: 'car' };

/**
 * Discriminated union of all supported search criteria shapes.
 * Controllers build the appropriate variant and pass it to the port.
 */
export type SearchCriteria =
  | FlightSearchCriteria
  | HotelSearchCriteria
  | CarSearchCriteria;

// ---------------------------------------------------------------------------
// Reservation token
// ---------------------------------------------------------------------------

/**
 * Opaque hold token returned by reserve().
 * Callers pass it verbatim to confirm() or cancel(); they must never parse
 * providerRef.
 */
export interface ReservationToken {
  readonly supplierName: string;
  readonly providerRef: string;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// SupplierPort interface
// ---------------------------------------------------------------------------

/**
 * Contract that every supplier adapter must implement.
 *
 * Constraints:
 *  - No provider-specific field may appear in parameters or return types.
 *  - All errors thrown must be SupplierError instances from ./errors.
 *  - Adapters must not construct their own HTTP client; they receive
 *    SupplierHttpClient via constructor injection.
 */
export interface SupplierPort {
  /** Human-readable supplier name used in errors, metrics, and log context. */
  readonly supplierName: string;

  /**
   * Booking protocols supported by this adapter.
   * Must contain at least one entry.
   */
  readonly supportedFlows: ReadonlyArray<SupplierFlowShape>;

  /**
   * Search for available offers matching the criteria.
   *
   * @param criteria - Travel search parameters (kind determines the vertical).
   * @param correlationId - Inbound request correlation ID, forwarded to supplier.
   * @returns Zero or more normalised Offer objects from @travel/contracts.
   */
  searchOffers(criteria: SearchCriteria, correlationId: string): Promise<ReadonlyArray<Offer>>;

  /**
   * Place a hold on an offer.  Supported only when supportedFlows includes
   * RESERVE_THEN_CONFIRM.  Must be called with allowRetry: false.
   *
   * @param offerId - The id from a prior searchOffers result.
   * @param correlationId - Inbound request correlation ID.
   */
  reserve?(offerId: string, correlationId: string): Promise<ReservationToken>;

  /**
   * Confirm a previously held reservation.  Must be called with
   * allowRetry: false.
   *
   * @param token - The token returned by reserve().
   * @param correlationId - Inbound request correlation ID.
   */
  confirm?(token: ReservationToken, correlationId: string): Promise<void>;
}
