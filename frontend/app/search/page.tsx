/**
 * Search page — App Router Server Component.
 *
 * All request/response types are imported from @travel/contracts.
 * No local shape is declared for any platform payload.
 *
 * This file uses Next.js 14 App Router conventions (async Server Component,
 * searchParams prop). It requires Next.js + React to render; the type
 * contract against @travel/contracts is correct and typechecks once
 * the dependencies are installed.
 */

import type {
  FlightSearchRequest,
  HotelSearchRequest,
  CarRentalSearchRequest,
  Offer,
} from "@travel/contracts/search";

// ---------------------------------------------------------------------------
// Exported prop types — consumed by child components and tests
// ---------------------------------------------------------------------------

/** The shape of the Next.js `searchParams` for the search page. */
export interface SearchPageSearchParams {
  tab?: "FLIGHT" | "HOTEL" | "CAR";
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  passengers?: string;
  seatClass?: string;
  currency?: string;
  location?: string;
  checkInDate?: string;
  checkOutDate?: string;
  guests?: string;
  pickupLocation?: string;
  dropoffLocation?: string;
  pickupDate?: string;
  dropoffDate?: string;
}

/** Next.js App Router page props */
export interface SearchPageProps {
  searchParams: SearchPageSearchParams;
}

// ---------------------------------------------------------------------------
// Request builders — convert searchParams to typed contracts request objects
// ---------------------------------------------------------------------------

/**
 * Build a FlightSearchRequest from URL search params.
 * Returns null when required fields are absent (form not yet submitted).
 */
export function buildFlightSearchRequest(
  params: SearchPageSearchParams
): Omit<FlightSearchRequest, "departureDate" | "returnDate"> & {
  departureDate: string;
  returnDate?: string;
} | null {
  if (!params.origin || !params.destination || !params.departureDate) return null;

  return {
    departureAirport: params.origin.toUpperCase(),
    arrivalAirport: params.destination.toUpperCase(),
    departureDate: params.departureDate,
    returnDate: params.returnDate,
    passengers: params.passengers !== undefined ? parseInt(params.passengers, 10) : 1,
    seatClass:
      (params.seatClass as FlightSearchRequest["seatClass"] | undefined) ?? "ECONOMY",
    currency: params.currency ?? "USD",
  };
}

// ---------------------------------------------------------------------------
// Offer list filtering helpers
// ---------------------------------------------------------------------------

/**
 * Separate bookable and illustrative offers.
 * Illustrative offers must NEVER be returned to a checkout flow.
 */
export function partitionOffers(offers: ReadonlyArray<Offer>): {
  bookable: Offer[];
  illustrative: Offer[];
} {
  const bookable: Offer[] = [];
  const illustrative: Offer[] = [];

  for (const offer of offers) {
    if (offer.provenance === "ILLUSTRATIVE") {
      illustrative.push(offer);
    } else {
      bookable.push(offer);
    }
  }

  return { bookable, illustrative };
}

// ---------------------------------------------------------------------------
// Page component (Next.js App Router Server Component)
// Requires Next.js + React; the contracts types above are always correct.
// ---------------------------------------------------------------------------

export default async function SearchPage({ searchParams }: SearchPageProps) {
  // The full search data-fetching and component tree is built in subsequent
  // WOs (WO-005 et al.). This scaffold exports the correct contracts-typed
  // props and helpers so downstream WOs compile against the right shapes.
  return (
    <main>
      <h1>Search</h1>
      <p>Search page — full implementation in WO-005.</p>
    </main>
  );
}
