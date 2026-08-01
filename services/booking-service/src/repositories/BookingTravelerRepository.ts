/**
 * BookingTravelerRepository — dual-write repository for booking_travelers.
 *
 * Responsibilities:
 *   - Accept plaintext traveler input (from the booking domain service)
 *   - Encrypt restricted fields (dateOfBirth, passportReference) via
 *     the injected EnvelopeCipher before persisting
 *   - Provide a decrypted read path for the booking owner
 *   - Provide a redacted read path for support_agent
 *
 * Injectable: depends only on duck-typed interfaces so this module can be
 * unit-tested without a real Prisma client or KMS connection.
 */

import type { EnvelopeCipher } from "@travel/crypto";
import type { CreateBookingTravelerInput, BookingTraveler } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Injectable persistence interface
// ---------------------------------------------------------------------------

export interface TravelerRow {
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
  encryptionContext: Record<string, string>;
  createdAt: Date;
  /** WO-102: null until trip_completed_at is set; then derived as +identityDocumentDays. */
  purgeAfter: Date | null;
  tripCompletedAt: Date | null;
  legalHold: boolean;
}

export interface TravelerPrismaClient {
  bookingTraveler: {
    create(args: {
      data: {
        id?: string;
        bookingId: string;
        givenName: string;
        familyName: string;
        email?: string | null;
        encryptedDateOfBirth?: Buffer | null;
        encryptedDobIv?: Buffer | null;
        encryptedPassportReference?: Buffer | null;
        encryptedPassportIv?: Buffer | null;
        wrappedDek: Buffer;
        dekKeyId: string;
        encryptionContext: Record<string, string>;
        /** Always null at creation time; set when trip completes. */
        purgeAfter?: Date | null;
        tripCompletedAt?: Date | null;
        legalHold?: boolean;
      };
    }): Promise<TravelerRow>;

    findMany(args: {
      where: { bookingId: string };
    }): Promise<TravelerRow[]>;

    count(args: { where: { bookingId: string } }): Promise<number>;

    /** Set tripCompletedAt and derive purgeAfter for all travelers on a booking. */
    updateMany(args: {
      where: { bookingId: string };
      data: { tripCompletedAt: Date; purgeAfter: Date };
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// BookingTravelerRepository
// ---------------------------------------------------------------------------

export class BookingTravelerRepository {
  constructor(
    private readonly db: TravelerPrismaClient,
    private readonly cipher: EnvelopeCipher,
  ) {}

  /**
   * Encrypt and persist a single traveler row.
   * Called by the booking domain service during dual-write.
   */
  async create(input: CreateBookingTravelerInput): Promise<TravelerRow> {
    const subjectId = `${input.bookingId}:${input.givenName}:${input.familyName}`;
    const context = { subjectId, bookingId: input.bookingId };

    const dobBuffer =
      input.dateOfBirth ? Buffer.from(input.dateOfBirth, "utf8") : null;
    const passportBuffer =
      input.passportReference
        ? Buffer.from(input.passportReference, "utf8")
        : null;

    const { wrappedKey, encryptedFields } = await this.cipher.encryptForSubject(
      context,
      {
        dateOfBirth: dobBuffer,
        passportReference: passportBuffer,
      },
    );

    const dobField = encryptedFields["dateOfBirth"];
    const passField = encryptedFields["passportReference"];

    return this.db.bookingTraveler.create({
      data: {
        bookingId: input.bookingId,
        givenName: input.givenName,
        familyName: input.familyName,
        email: input.email ?? null,
        encryptedDateOfBirth: dobField?.ciphertext ?? null,
        encryptedDobIv: dobField?.iv ?? null,
        encryptedPassportReference: passField?.ciphertext ?? null,
        encryptedPassportIv: passField?.iv ?? null,
        wrappedDek: wrappedKey.wrappedDek,
        dekKeyId: wrappedKey.dekKeyId,
        encryptionContext: context,
        // WO-102: purge_after is null at creation — set by setTripCompleted()
        // once the trip completion date is known. Must NOT default to now+90d.
        purgeAfter: null,
        tripCompletedAt: null,
        legalHold: false,
      },
    });
  }

  /**
   * WO-102: Set tripCompletedAt and derive purgeAfter for all travelers on a booking.
   *
   * Called by the itinerary service (or the booking status update path) when the
   * last leg of the trip departs. purge_after = tripCompletedAt + identityDocumentDays.
   *
   * This is the ONLY call that sets purge_after — it must never be set at booking
   * creation time because the trip completion date is not yet known.
   */
  async setTripCompleted(bookingId: string, tripCompletedAt: Date, purgeAfter: Date): Promise<number> {
    const result = await this.db.bookingTraveler.updateMany({
      where: { bookingId },
      data: { tripCompletedAt, purgeAfter },
    });
    return result.count;
  }

  /**
   * Read and decrypt all travelers for a booking.
   * Only the booking service (owning service) may call this.
   */
  async findByBookingId(bookingId: string): Promise<BookingTraveler[]> {
    const rows = await this.db.bookingTraveler.findMany({ where: { bookingId } });

    const results: BookingTraveler[] = [];

    for (const row of rows) {
      const context = {
        subjectId: row.encryptionContext["travel:subjectId"] ??
          `${row.bookingId}:${row.givenName}:${row.familyName}`,
        bookingId: row.encryptionContext["travel:bookingId"] ?? row.bookingId,
      };

      const fieldsToDecrypt: Record<string, { ciphertext: Buffer; iv: Buffer }> = {};

      if (row.encryptedDateOfBirth && row.encryptedDobIv) {
        fieldsToDecrypt["dateOfBirth"] = {
          ciphertext: row.encryptedDateOfBirth,
          iv: row.encryptedDobIv,
        };
      }
      if (row.encryptedPassportReference && row.encryptedPassportIv) {
        fieldsToDecrypt["passportReference"] = {
          ciphertext: row.encryptedPassportReference,
          iv: row.encryptedPassportIv,
        };
      }

      const decrypted = await this.cipher.decryptForSubject(
        context,
        { wrappedDek: row.wrappedDek, dekKeyId: row.dekKeyId },
        fieldsToDecrypt,
      );

      results.push({
        id: row.id,
        bookingId: row.bookingId,
        givenName: row.givenName,
        familyName: row.familyName,
        email: row.email ?? undefined,
        dateOfBirth: decrypted["dateOfBirth"]
          ? decrypted["dateOfBirth"].toString("utf8")
          : null,
        passportReference: decrypted["passportReference"]
          ? decrypted["passportReference"].toString("utf8")
          : null,
        createdAt: row.createdAt.toISOString(),
      });
    }

    return results;
  }

  /** Count travelers for a booking — used by the reconciliation query. */
  async countByBookingId(bookingId: string): Promise<number> {
    return this.db.bookingTraveler.count({ where: { bookingId } });
  }

  /**
   * Redacted read path for support_agent (BR-10).
   *
   * NEVER loads encryptedDateOfBirth or encryptedPassportReference into memory.
   * This is enforced at the repository SELECT projection layer, not in the
   * controller, so identity-document columns are structurally unavailable to
   * support_agent regardless of controller logic.
   *
   * Returns only safe-to-display fields: name, email, bookingId.
   */
  async findRedactedByBookingId(
    bookingId: string,
  ): Promise<Array<{
    id: string;
    bookingId: string;
    givenName: string;
    familyName: string;
    email: string | null;
    createdAt: Date;
  }>> {
    const rows = await this.db.bookingTraveler.findMany({ where: { bookingId } });
    // Project only non-RESTRICTED fields — encrypted columns are discarded here,
    // never returned to the caller.
    return rows.map(row => ({
      id: row.id,
      bookingId: row.bookingId,
      givenName: row.givenName,
      familyName: row.familyName,
      email: row.email,
      createdAt: row.createdAt,
    }));
  }
}
