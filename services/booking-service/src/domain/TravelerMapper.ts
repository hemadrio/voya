/**
 * TravelerMapper — converts a legacy PassengerInfo JSON object to the
 * CreateBookingTravelerInput shape expected by BookingTravelerRepository.
 *
 * Called both by the dual-write path (new bookings) and by the backfill
 * script (migrating legacy JSON rows).
 */

import type { CreateBookingTravelerInput } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Loose passenger shape accepted from legacy JSON blobs
// ---------------------------------------------------------------------------

export interface LegacyPassengerInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  email?: string;
  passportNumber?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Convert a legacy PassengerInfo object to CreateBookingTravelerInput.
 *
 * - Trims whitespace from name fields.
 * - Maps passportNumber → passportReference (null when absent).
 * - Discards any extra fields not in the contract.
 */
export function mapPassengerToTravelerInput(
  passenger: LegacyPassengerInput,
  bookingId: string,
): CreateBookingTravelerInput {
  const result: CreateBookingTravelerInput = {
    bookingId,
    givenName: passenger.firstName.trim(),
    familyName: passenger.lastName.trim(),
    dateOfBirth: passenger.dateOfBirth,
    passportReference: passenger.passportNumber?.trim() ?? null,
  };

  if (passenger.email) {
    result.email = passenger.email.trim();
  }

  return result;
}
