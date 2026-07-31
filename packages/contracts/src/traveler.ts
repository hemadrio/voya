import { z } from "zod";

// ---------------------------------------------------------------------------
// BookingTraveler — normalized traveler identity relation schema (WO-073)
// ---------------------------------------------------------------------------

/**
 * The shape returned by the booking read path for a single traveler.
 * Encrypted fields are represented as Buffer (after decryption by the
 * booking service) or null when the source passenger lacked the field.
 *
 * The frontend and other consumers receive the *decrypted* view; the raw
 * bytea columns are never exposed outside the booking service.
 */
export const BookingTravelerSchema = z
  .object({
    id: z.string().uuid(),
    bookingId: z.string().uuid(),
    givenName: z.string(),
    familyName: z.string(),
    email: z.string().email().optional(),
    /** Decrypted date of birth (YYYY-MM-DD ISO string), null if not captured. */
    dateOfBirth: z.string().nullable(),
    /** Decrypted passport number, null if not captured. */
    passportReference: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type BookingTraveler = z.infer<typeof BookingTravelerSchema>;

/**
 * Input shape for the dual-write path: what the booking service writes when
 * creating a new booking from a CreateBookingRequest.
 *
 * `dateOfBirth` and `passportReference` are plaintext at this layer —
 * the BookingTravelerRepository handles encryption before persisting.
 */
export const CreateBookingTravelerInputSchema = z
  .object({
    bookingId: z.string().uuid(),
    givenName: z.string().trim().min(1),
    familyName: z.string().trim().min(1),
    email: z.string().trim().email().optional(),
    /** YYYY-MM-DD — will be encrypted before storage. */
    dateOfBirth: z.string(),
    /** Passport number — will be encrypted before storage. Null if not provided. */
    passportReference: z.string().nullable(),
  })
  .strict();

export type CreateBookingTravelerInput = z.infer<typeof CreateBookingTravelerInputSchema>;

/**
 * Support-agent view: encrypted identity columns are redacted.
 * Other columns (name, email, bookingId) remain readable.
 */
export const SupportAgentBookingTravelerSchema = z
  .object({
    id: z.string().uuid(),
    bookingId: z.string().uuid(),
    givenName: z.string(),
    familyName: z.string(),
    email: z.string().email().optional(),
    dateOfBirth: z.literal("[REDACTED]"),
    passportReference: z.literal("[REDACTED]"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type SupportAgentBookingTraveler = z.infer<typeof SupportAgentBookingTravelerSchema>;
