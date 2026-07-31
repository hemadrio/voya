/**
 * TravelPreference seed factory — Bob's saved preferences for business travel.
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT, RETENTION } from "../identifiers.js";

export interface TravelPreferenceSeed {
  id: string;
  userId: string;
  preferredSeatClass: string | null;
  preferredCurrency: string | null;
  preferredAirlines: string[];
  dietaryRestrictions: string[];
  createdAt: Date;
  updatedAt: Date;
  classification: "CONFIDENTIAL";
  purgeAfter: Date | null;
}

export function makeTravelPreference(overrides: Partial<TravelPreferenceSeed> = {}): TravelPreferenceSeed {
  return {
    id: SEED_IDS.preference.bob,
    userId: SEED_IDS.user.bob,
    preferredSeatClass: "BUSINESS",
    preferredCurrency: "USD",
    preferredAirlines: ["SYNTH-AIRLINE-BA", "SYNTH-AIRLINE-LH"],
    dietaryRestrictions: [],
    createdAt: SEED_REFERENCE_INSTANT,
    updatedAt: SEED_REFERENCE_INSTANT,
    classification: "CONFIDENTIAL",
    purgeAfter: RETENTION.preference,
    ...overrides,
  };
}

export const SEED_PREFERENCES: TravelPreferenceSeed[] = [makeTravelPreference()];
