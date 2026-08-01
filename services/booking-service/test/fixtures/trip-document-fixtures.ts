/**
 * Trip document test fixtures (WO-054, AC12).
 *
 * CRITICAL: The passengers/travellers arrays below intentionally include
 * fake dateOfBirth and passportNumber values in the "raw" (DB) shape.
 * These values must NEVER appear in TravellerViewModel or in the rendered PDF.
 * The exclusion tests in trip-document-service.test.ts assert their absence.
 *
 * All IDs and PII values are synthetic (SYNTH-* prefix or obvious fakes).
 * NEVER use real or production-derived data.
 */

import type { ItineraryDocumentRow } from "../../src/domain/TripDocumentService.js";

// ---------------------------------------------------------------------------
// Synthetic PII values — must be absent from the rendered PDF
// ---------------------------------------------------------------------------

export const SYNTH_DOB_1 = "1990-04-15"; // dateOfBirth — MUST NOT appear in PDF
export const SYNTH_PASSPORT_1 = "SYNTH-PASSPORT-A1B2C3"; // MUST NOT appear in PDF
export const SYNTH_DOB_2 = "1985-11-22"; // dateOfBirth — MUST NOT appear in PDF
export const SYNTH_PASSPORT_2 = "SYNTH-PASSPORT-D4E5F6"; // MUST NOT appear in PDF

// Synthetic payment ID — MUST NOT appear in PDF
export const SYNTH_PAYMENT_INTENT_ID = "pi_SYNTH000000000FORBIDDEN";

// ---------------------------------------------------------------------------
// User and itinerary IDs
// ---------------------------------------------------------------------------

export const SYNTH_USER_ID = "f0000001-0000-4000-8000-000000000001";
export const SYNTH_ITINERARY_ID = "f0000002-0000-4000-8000-000000000001";
export const SYNTH_ITINERARY_NAME = "SYNTH Paris Trip 2026";

// ---------------------------------------------------------------------------
// Itinerary with mixed CONFIRMED + PENDING bookings
// Includes passengers JSON with PII fields — projection must strip them.
// ---------------------------------------------------------------------------

export const FIXTURE_ITINERARY_MIXED_STATUS: ItineraryDocumentRow = {
  id: SYNTH_ITINERARY_ID,
  userId: SYNTH_USER_ID,
  name: SYNTH_ITINERARY_NAME,
  startDate: new Date("2026-06-01T00:00:00Z"),
  endDate: new Date("2026-06-10T00:00:00Z"),
  bookings: [
    {
      id: "b0000001-0000-4000-8000-000000000001",
      bookingType: "flight",
      status: "CONFIRMED",
      totalPrice: { toString: () => "499.99" },
      currency: "USD",
      supplier: "AMADEUS",
      confirmationReference: "PNR-SYNTH-F001",
      travelStartDate: new Date("2026-06-01T08:00:00Z"),
      travelEndDate: new Date("2026-06-01T12:00:00Z"),
      origin: "LHR",
      destination: "CDG",
      // Name-only travellers — NO dateOfBirth, NO passportNumber in this type.
      travellers: [
        { givenName: "Alice", familyName: "Smith" },
        { givenName: "Bob", familyName: "Smith" },
      ],
    },
    {
      id: "b0000002-0000-4000-8000-000000000001",
      bookingType: "hotel",
      status: "PENDING",
      totalPrice: { toString: () => "250.00" },
      currency: "USD",
      supplier: "RAPIDAPI_HOTEL",
      confirmationReference: undefined,
      travelStartDate: new Date("2026-06-01T14:00:00Z"),
      travelEndDate: new Date("2026-06-10T11:00:00Z"),
      origin: undefined,
      destination: undefined,
      travellers: [
        { givenName: "Alice", familyName: "Smith" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Itinerary with ALL bookings PENDING — triggers 409 precondition failure
// ---------------------------------------------------------------------------

export const FIXTURE_ITINERARY_ALL_PENDING: ItineraryDocumentRow = {
  id: "f0000003-0000-4000-8000-000000000001",
  userId: SYNTH_USER_ID,
  name: "SYNTH All-Pending Itinerary",
  startDate: new Date("2026-07-01T00:00:00Z"),
  endDate: new Date("2026-07-05T00:00:00Z"),
  bookings: [
    {
      id: "b0000003-0000-4000-8000-000000000001",
      bookingType: "flight",
      status: "PENDING",
      totalPrice: { toString: () => "300.00" },
      currency: "EUR",
      travellers: [{ givenName: "Carol", familyName: "Jones" }],
    },
    {
      id: "b0000004-0000-4000-8000-000000000001",
      bookingType: "hotel",
      status: "PENDING",
      totalPrice: { toString: () => "200.00" },
      currency: "EUR",
      travellers: [{ givenName: "Carol", familyName: "Jones" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Multi-currency itinerary — per-currency totals must NOT be summed
// ---------------------------------------------------------------------------

export const FIXTURE_ITINERARY_MULTI_CURRENCY: ItineraryDocumentRow = {
  id: "f0000004-0000-4000-8000-000000000001",
  userId: SYNTH_USER_ID,
  name: "SYNTH Multi-Currency Trip",
  startDate: new Date("2026-08-01T00:00:00Z"),
  endDate: new Date("2026-08-15T00:00:00Z"),
  bookings: [
    {
      id: "b0000005-0000-4000-8000-000000000001",
      bookingType: "flight",
      status: "CONFIRMED",
      totalPrice: { toString: () => "412.50" },
      currency: "USD",
      supplier: "AMADEUS",
      confirmationReference: "PNR-SYNTH-USD",
      travellers: [{ givenName: "Dave", familyName: "Brown" }],
    },
    {
      id: "b0000006-0000-4000-8000-000000000001",
      bookingType: "hotel",
      status: "CONFIRMED",
      totalPrice: { toString: () => "380.00" },
      currency: "EUR",
      supplier: "RAPIDAPI_HOTEL",
      confirmationReference: "HTL-SYNTH-EUR",
      travellers: [{ givenName: "Dave", familyName: "Brown" }],
    },
    {
      id: "b0000007-0000-4000-8000-000000000001",
      bookingType: "car",
      status: "CONFIRMED",
      totalPrice: { toString: () => "120.00" },
      currency: "GBP",
      supplier: "RAPIDAPI_CAR",
      confirmationReference: "CAR-SYNTH-GBP",
      travellers: [{ givenName: "Dave", familyName: "Brown" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Poisoned booking — raw DB row with PII fields present (as they would come
// from a naive SELECT *).  The TravellerNameInput type ONLY has givenName +
// familyName, so these fields are structurally impossible in the type.
// The fixture is used in negative tests to confirm they are not in the output.
// ---------------------------------------------------------------------------

export const POISONED_TRAVELLER_DB_ROW = {
  givenName: "Eve",
  familyName: "Taylor",
  // The following fields exist in the raw DB JSON column — they MUST NOT
  // appear anywhere in TravellerViewModel or in the rendered PDF byte stream.
  dateOfBirth: SYNTH_DOB_1,
  passportNumber: SYNTH_PASSPORT_1,
  passportExpiry: "2030-01-01",
  documentType: "PASSPORT",
  // Payment context that must never appear
  paymentIntentId: SYNTH_PAYMENT_INTENT_ID,
};

export const FIXTURE_ITINERARY_POISONED: ItineraryDocumentRow = {
  id: "f0000005-0000-4000-8000-000000000001",
  userId: SYNTH_USER_ID,
  name: "SYNTH Poisoned Itinerary",
  startDate: new Date("2026-09-01T00:00:00Z"),
  endDate: new Date("2026-09-07T00:00:00Z"),
  bookings: [
    {
      id: "b0000008-0000-4000-8000-000000000001",
      bookingType: "flight",
      status: "CONFIRMED",
      totalPrice: { toString: () => "599.00" },
      currency: "USD",
      supplier: "AMADEUS",
      confirmationReference: "PNR-SYNTH-POISON",
      travellers: [
        // Type is TravellerNameInput which only has givenName + familyName.
        // Extra fields from POISONED_TRAVELLER_DB_ROW are structurally excluded.
        { givenName: POISONED_TRAVELLER_DB_ROW.givenName, familyName: POISONED_TRAVELLER_DB_ROW.familyName },
      ],
    },
    {
      id: "b0000009-0000-4000-8000-000000000001",
      bookingType: "hotel",
      status: "CONFIRMED",
      totalPrice: { toString: () => "450.00" },
      currency: "USD",
      supplier: "RAPIDAPI_HOTEL",
      confirmationReference: "HTL-SYNTH-POISON",
      travellers: [
        { givenName: POISONED_TRAVELLER_DB_ROW.givenName, familyName: POISONED_TRAVELLER_DB_ROW.familyName },
      ],
    },
  ],
};
