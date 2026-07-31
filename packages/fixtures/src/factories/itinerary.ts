/**
 * Itinerary seed factories.
 *
 * Three itineraries covering the documented personas:
 *   1. Alice's multi-category itinerary (flight + hotel + car)
 *   2. Bob's business trip
 *   3. Charlie's guest-originated itinerary, re-parented after account creation
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT, refDate, RETENTION } from "../identifiers.js";

export interface ItinerarySeed {
  id: string;
  userId: string;
  title: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  classification: "CONFIDENTIAL";
  purgeAfter: Date | null;
}

export function makeItinerary(overrides: Partial<ItinerarySeed> = {}): ItinerarySeed {
  return {
    id: SEED_IDS.itinerary.aliceMultiCategory,
    userId: SEED_IDS.user.alice,
    title: "Synthetic Multi-Category Trip",
    notes: null,
    createdAt: SEED_REFERENCE_INSTANT,
    updatedAt: SEED_REFERENCE_INSTANT,
    classification: "CONFIDENTIAL",
    purgeAfter: RETENTION.itinerary,
    ...overrides,
  };
}

export const SEED_ITINERARIES: ItinerarySeed[] = [
  makeItinerary({
    id: SEED_IDS.itinerary.aliceMultiCategory,
    userId: SEED_IDS.user.alice,
    title: "Synthetic Multi-Category Trip — Alice",
    notes: "Covers flight, hotel, and car rental in a single itinerary.",
  }),
  makeItinerary({
    id: SEED_IDS.itinerary.bobBusiness,
    userId: SEED_IDS.user.bob,
    title: "Synthetic Business Trip — Bob",
    notes: "Business travel with saved preferences applied.",
    createdAt: refDate(60 * 1000),
    updatedAt: refDate(60 * 1000),
  }),
  makeItinerary({
    id: SEED_IDS.itinerary.charlieReparented,
    // Re-parented to Charlie's account after guest checkout.
    userId: SEED_IDS.user.charlie,
    title: "Synthetic Guest-Originated Trip — Charlie",
    notes: "Originally created without an account; re-parented on sign-up.",
    createdAt: refDate(120 * 1000),
    updatedAt: refDate(130 * 1000),
  }),
];
