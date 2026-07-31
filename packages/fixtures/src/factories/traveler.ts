/**
 * BookingTraveler seed factories.
 *
 * Identity-document fields (dateOfBirth, passportReference) are stored
 * as KMS-encrypted bytes in production. In the seed we use placeholder
 * byte buffers whose ASCII decoding begins with "SYNTH-" to make the
 * synthetic origin unmistakable.
 *
 * The wrapped DEK is also synthetic — a 32-byte buffer that is clearly
 * not a real AWS KMS CiphertextBlob (those are base64-encoded and much
 * longer). The seed must not call KMS so services under test can run
 * against a local database without AWS credentials.
 *
 * Classification: RESTRICTED. purgeAfter is set to trip_completed_at + 90 days
 * per the data-retention policy. For seed purposes we use RETENTION.identityDocument.
 */

import { SEED_IDS, SEED_REFERENCE_INSTANT, refDate, RETENTION } from "../identifiers.js";

const SYNTH_IV = Buffer.alloc(16, 0x53); // 0x53 = 'S'
const SYNTH_WRAPPED_DEK = Buffer.from("SYNTH-WRAPPED-DEK-0000000000000000"); // 34 bytes, obviously synthetic
const SYNTH_KMS_KEY_ID = "arn:aws:kms:eu-west-1:000000000000:key/f0000000-0000-4000-8000-000000000000";

export interface BookingTravelerSeed {
  id: string;
  bookingId: string;
  givenName: string;
  familyName: string;
  email: string | null;
  encryptedDateOfBirth: Buffer | null;
  encryptedDobIv: Buffer | null;
  encryptedPassportReference: Buffer | null;
  encryptedPassportIv: Buffer | null;
  wrappedDek: Buffer;
  dekKeyId: string;
  encryptionContext: object;
  createdAt: Date;
  classification: "RESTRICTED";
  purgeAfter: Date | null;
  tripCompletedAt: Date | null;
}

export function makeBookingTraveler(overrides: Partial<BookingTravelerSeed> = {}): BookingTravelerSeed {
  return {
    id: SEED_IDS.traveler.aliceOnFlight,
    bookingId: SEED_IDS.booking.flightConfirmed,
    givenName: "Alice",
    familyName: "Leisure",
    email: "alice.leisure@synth.example",
    // Synthetic encrypted value — plaintext would be "SYNTH-DOB-19900315"
    encryptedDateOfBirth: Buffer.from("SYNTH-ENC-DOB-0000000000000000000"),
    encryptedDobIv: SYNTH_IV,
    // Synthetic encrypted value — plaintext would be "SYNTH-PASSPORT-XX0000001"
    encryptedPassportReference: Buffer.from("SYNTH-ENC-PASSPORT-00000000000000"),
    encryptedPassportIv: SYNTH_IV,
    wrappedDek: SYNTH_WRAPPED_DEK,
    dekKeyId: SYNTH_KMS_KEY_ID,
    encryptionContext: {
      bookingId: SEED_IDS.booking.flightConfirmed,
      travelerId: SEED_IDS.traveler.aliceOnFlight,
      purpose: "identity-document",
    },
    createdAt: SEED_REFERENCE_INSTANT,
    classification: "RESTRICTED",
    purgeAfter: RETENTION.identityDocument,
    tripCompletedAt: refDate(30 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

export const SEED_TRAVELERS: BookingTravelerSeed[] = [
  makeBookingTraveler(),
  makeBookingTraveler({
    id: SEED_IDS.traveler.bobOnFlight,
    bookingId: SEED_IDS.booking.pendingActive,
    givenName: "Bob",
    familyName: "Business",
    email: "bob.business@synth.example",
    encryptedDateOfBirth: Buffer.from("SYNTH-ENC-DOB-BOB-000000000000000"),
    encryptedPassportReference: Buffer.from("SYNTH-ENC-PASSPORT-BOB-0000000000"),
    encryptionContext: {
      bookingId: SEED_IDS.booking.pendingActive,
      travelerId: SEED_IDS.traveler.bobOnFlight,
      purpose: "identity-document",
    },
    tripCompletedAt: null,
    purgeAfter: null,
  }),
];
