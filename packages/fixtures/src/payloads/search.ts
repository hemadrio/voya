/**
 * Static supplier response payload fixtures.
 *
 * These represent the shapes that search-service receives from Amadeus/RapidAPI
 * and maps to the internal Offer schema. Validated against OfferSchema at module
 * load in the schema-drift test so a contract change fails immediately.
 *
 * All price, date, and identifier values are unmistakably synthetic.
 * Departure/arrival dates are computed from Date.now() + offset so they
 * remain in the future regardless of when the test suite runs.
 */

/** Compute a future ISO-8601 date string. Safe to call at module load. */
function futureIso(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

export const SYNTHETIC_FLIGHT_OFFER = {
  id: "SYNTH-AMADEUS-FL-001",
  provenance: "AMADEUS" as const,
  bookable: true,
  title: "Synthetic Flight LHR → JFK — Economy",
  price: "412.50",
  currency: "USD",
  details: {
    departureAirport: "LHR",
    arrivalAirport: "JFK",
    departureDate: futureIso(30),
    returnDate: futureIso(37),
    passengers: 1,
    seatClass: "ECONOMY",
    airline: "SYNTH-AIRLINE-BA",
    flightNumber: "SYNTH-BA-0001",
  },
  expiresAt: futureIso(0.021), // ~30 minutes
  freshness: "FRESH" as const,
};

export const SYNTHETIC_HOTEL_OFFER = {
  id: "SYNTH-RAPIDAPI-HT-001",
  provenance: "RAPIDAPI" as const,
  bookable: true,
  title: "Synthetic Hotel — New York, 4 stars",
  price: "210.00",
  currency: "USD",
  rating: 4,
  reviews: 1200,
  details: {
    city: "New York",
    stars: 4,
    checkIn: futureIso(30),
    checkOut: futureIso(37),
    roomType: "STANDARD_DOUBLE",
    breakfastIncluded: false,
    hotelId: "SYNTH-HOTEL-NYC-001",
  },
  expiresAt: futureIso(0.021),
  freshness: "FRESH" as const,
};

export const SYNTHETIC_CAR_OFFER = {
  id: "SYNTH-AMADEUS-CR-001",
  provenance: "AMADEUS" as const,
  bookable: true,
  title: "Synthetic Car Rental — Compact, 7 days",
  price: "89.00",
  currency: "USD",
  details: {
    pickupLocation: "JFK",
    dropoffLocation: "JFK",
    pickupDate: futureIso(30),
    dropoffDate: futureIso(37),
    carClass: "COMPACT",
    supplierId: "SYNTH-CAR-SUPPLIER-001",
  },
  expiresAt: futureIso(0.021),
  freshness: "FRESH" as const,
};

/**
 * Illustrative (non-bookable) offer — provenance=ILLUSTRATIVE, bookable=false.
 * The booking service must structurally reject this; the OfferSchema enforces
 * the invariant that ILLUSTRATIVE + bookable=true is impossible.
 */
export const SYNTHETIC_ILLUSTRATIVE_OFFER = {
  id: "SYNTH-ILLUSTRATIVE-001",
  provenance: "ILLUSTRATIVE" as const,
  bookable: false,
  title: "Illustrative Flight Offer — NOT BOOKABLE",
  price: "0.01",
  currency: "USD",
  details: {
    note: "This is an AI-generated illustrative offer. It cannot be booked.",
    synthetic: true,
  },
  expiresAt: futureIso(1),
  freshness: "STALE" as const,
};

/** Flight search request that uses future dates — safe for validation against FlightSearchRequestSchema. */
export const SYNTHETIC_FLIGHT_SEARCH_REQUEST = {
  departureAirport: "LHR",
  arrivalAirport: "JFK",
  departureDate: futureIso(30),
  returnDate: futureIso(37),
  passengers: 1,
  seatClass: "ECONOMY" as const,
  currency: "USD",
};

export const SYNTHETIC_HOTEL_SEARCH_REQUEST = {
  location: "New York",
  checkInDate: futureIso(30),
  checkOutDate: futureIso(37),
  guests: 1,
  currency: "USD",
};

export const SYNTHETIC_CAR_SEARCH_REQUEST = {
  pickupLocation: "JFK",
  dropoffLocation: "JFK",
  pickupDate: futureIso(30),
  dropoffDate: futureIso(37),
  carClass: "COMPACT" as const,
  currency: "USD",
};
