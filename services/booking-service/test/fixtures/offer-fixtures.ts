/**
 * Offer fixtures for WO-039 tests.
 *
 * Covers the four canonical provenance variants used by both unit and
 * integration test layers:
 *   - AMADEUS_FLIGHT_OFFER   — real Amadeus flight, bookable=true
 *   - RAPIDAPI_HOTEL_OFFER   — real RapidAPI hotel, bookable=true
 *   - RAPIDAPI_CAR_OFFER     — real RapidAPI car rental, bookable=true
 *   - ILLUSTRATIVE_OFFER     — AI-generated placeholder, bookable=false (structurally non-bookable)
 *
 * Use FIXTURE_NOW as the reference instant (deterministic — no Date.now()).
 */

import type { ResolvedOffer } from "../../src/domain/OfferPort.js";

/** Fixed reference instant for all offer expiry calculations. */
export const FIXTURE_NOW = new Date("2026-07-31T12:00:00.000Z");

/** Offer expires 30 minutes after the fixture reference instant. */
export const FIXTURE_OFFER_EXPIRES_AT = new Date("2026-07-31T12:30:00.000Z");

/** Offer that expired 1 minute before the fixture reference instant. */
export const FIXTURE_EXPIRED_AT = new Date("2026-07-31T11:59:00.000Z");

// ---------------------------------------------------------------------------
// AMADEUS flight offer
// ---------------------------------------------------------------------------

export const AMADEUS_FLIGHT_OFFER: ResolvedOffer = {
  offerId: "amadeus-offer-001",
  provenance: "AMADEUS",
  supplier: "Amadeus GDS",
  bookable: true,
  totalPrice: 412.50,
  currency: "USD",
  expiresAt: FIXTURE_OFFER_EXPIRES_AT,
  legs: [
    {
      offerId: "amadeus-leg-001",
      supplier: "Amadeus GDS",
      provenance: "AMADEUS",
      origin: "LHR",
      destination: "JFK",
      departureAt: new Date("2026-08-15T09:00:00.000Z"),
      arrivalAt: new Date("2026-08-15T12:00:00.000Z"),
    },
  ],
};

// ---------------------------------------------------------------------------
// RapidAPI hotel offer
// ---------------------------------------------------------------------------

export const RAPIDAPI_HOTEL_OFFER: ResolvedOffer = {
  offerId: "rapidapi-hotel-offer-001",
  provenance: "RAPIDAPI_HOTEL",
  supplier: "Hotels.com via RapidAPI",
  bookable: true,
  totalPrice: 189.00,
  currency: "USD",
  expiresAt: FIXTURE_OFFER_EXPIRES_AT,
  legs: [
    {
      offerId: "rapidapi-hotel-leg-001",
      supplier: "Hotels.com via RapidAPI",
      provenance: "RAPIDAPI_HOTEL",
      checkInDate: "2026-08-15",
      checkOutDate: "2026-08-17",
    },
  ],
};

// ---------------------------------------------------------------------------
// RapidAPI car rental offer
// ---------------------------------------------------------------------------

export const RAPIDAPI_CAR_OFFER: ResolvedOffer = {
  offerId: "rapidapi-car-offer-001",
  provenance: "RAPIDAPI_CAR",
  supplier: "Hertz via RapidAPI",
  bookable: true,
  totalPrice: 75.00,
  currency: "USD",
  expiresAt: FIXTURE_OFFER_EXPIRES_AT,
  legs: [
    {
      offerId: "rapidapi-car-leg-001",
      supplier: "Hertz via RapidAPI",
      provenance: "RAPIDAPI_CAR",
      pickUpDate: "2026-08-15",
      dropOffDate: "2026-08-17",
      origin: "JFK",
    },
  ],
};

// ---------------------------------------------------------------------------
// ILLUSTRATIVE (AI-generated placeholder — never bookable)
// ---------------------------------------------------------------------------

export const ILLUSTRATIVE_OFFER: ResolvedOffer = {
  offerId: "illustrative-offer-001",
  provenance: "ILLUSTRATIVE",
  supplier: "AI Planner",
  bookable: false,
  totalPrice: 350.00,
  currency: "USD",
  expiresAt: FIXTURE_OFFER_EXPIRES_AT,
  legs: [
    {
      offerId: "illustrative-leg-001",
      supplier: "AI Planner",
      provenance: "ILLUSTRATIVE",
      origin: "LHR",
      destination: "CDG",
    },
  ],
};

// ---------------------------------------------------------------------------
// Expired AMADEUS offer (expiresAt in the past)
// ---------------------------------------------------------------------------

export const EXPIRED_AMADEUS_OFFER: ResolvedOffer = {
  ...AMADEUS_FLIGHT_OFFER,
  offerId: "amadeus-offer-expired-001",
  expiresAt: FIXTURE_EXPIRED_AT,
};
