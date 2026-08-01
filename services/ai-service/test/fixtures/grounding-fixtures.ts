/**
 * Grounding test fixtures (WO-060).
 *
 * Provides: synthetic ProvenanceLedger entries, scripted model outputs, and
 * tool response payloads for flights, hotels, and cars.
 */

import { ProvenanceLedger } from "../../src/domain/grounding/ProvenanceLedger.js";

// ---------------------------------------------------------------------------
// Epoch constants for deterministic tests (fixed "now")
// ---------------------------------------------------------------------------

export const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z
export const FRESHNESS_MS = 15 * 60 * 1000;
export const STALE_AGE_MS = NOW_MS - FRESHNESS_MS - 1_000; // just expired

// ---------------------------------------------------------------------------
// Raw tool response fixtures
// ---------------------------------------------------------------------------

export const FLIGHT_TOOL_RESPONSE = [
  {
    id: "flight-001",
    provenance: "AMADEUS",
    bookable: true,
    title: "LHR → JFK",
    price: 412.5,
    currency: "USD",
    from: "LHR",
    to: "JFK",
  },
  {
    id: "flight-002",
    provenance: "AMADEUS",
    bookable: true,
    title: "LHR → JFK (afternoon)",
    price: 389.0,
    currency: "USD",
    from: "LHR",
    to: "JFK",
  },
];

export const HOTEL_TOOL_RESPONSE = [
  {
    id: "hotel-001",
    provenance: "RAPIDAPI_HOTEL",
    bookable: true,
    title: "Marriott Paris",
    price: 189.0,
    currency: "EUR",
    property: "Marriott Paris",
  },
];

export const CAR_TOOL_RESPONSE = [
  {
    id: "car-001",
    provenance: "RAPIDAPI_CAR",
    bookable: true,
    title: "Economy Hertz",
    price: 75.0,
    currency: "USD",
    property: "Economy Hertz",
  },
];

export const EMPTY_TOOL_RESPONSE: never[] = [];

// ---------------------------------------------------------------------------
// Pre-built ledger helpers
// ---------------------------------------------------------------------------

/** Ledger with one fresh flight offer. */
export function makeFlightLedger(retrievedAt = NOW_MS): ProvenanceLedger {
  const ledger = new ProvenanceLedger();
  ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, retrievedAt);
  return ledger;
}

/** Ledger with a stale flight offer. */
export function makeStaleLedger(): ProvenanceLedger {
  const ledger = new ProvenanceLedger();
  ledger.record("search_flights", FLIGHT_TOOL_RESPONSE, STALE_AGE_MS);
  return ledger;
}

/** Ledger with hotel offer. */
export function makeHotelLedger(retrievedAt = NOW_MS): ProvenanceLedger {
  const ledger = new ProvenanceLedger();
  ledger.record("search_hotels", HOTEL_TOOL_RESPONSE, retrievedAt);
  return ledger;
}

/** Empty ledger (tool returned zero results). */
export function makeEmptyLedger(): ProvenanceLedger {
  return new ProvenanceLedger();
}

// ---------------------------------------------------------------------------
// Scripted model outputs
// ---------------------------------------------------------------------------

/** Contains correct price + route claims that match flight-001 */
export const GROUNDED_MODEL_OUTPUT =
  "Great news! I found a flight from LHR to JFK for $412.50 USD. Seats are available and the flight is bookable.";

/** Contains a price that is off by $0.01 — near-miss unsupported */
export const NEAR_MISS_PRICE_MODEL_OUTPUT =
  "The fare from LHR to JFK is $412.51 USD. Seats are available.";

/** Contains a fabricated offer reference that never appeared in any tool result */
export const FABRICATED_OFFER_MODEL_OUTPUT =
  "I found a great deal for $199.00 USD on the JFK to CDG route. Book now!";

/** Contains a euro price matching hotel-001 */
export const HOTEL_GROUNDED_MODEL_OUTPUT =
  "The Marriott Paris is available at €189 EUR per night. Rooms are available.";

/** Contains no factual claims — should pass through unchanged */
export const NO_CLAIMS_MODEL_OUTPUT =
  "What dates are you looking to travel? I can search for available options once I have your travel dates.";

/** Contains stale availability reference */
export const STALE_AVAILABILITY_MODEL_OUTPUT =
  "The flight from LHR to JFK costs $412.50 USD and seats are available.";

/** Currency mismatch — model says dollars but ledger has euros */
export const CURRENCY_MISMATCH_MODEL_OUTPUT =
  "The hotel room costs $189 USD per night. Rooms are available.";
