/**
 * BookingRepository — ownership-predicate queries.
 *
 * Every read/write on a Booking MUST go through this repository so the
 * owner predicate (WHERE id = $bookingId AND user_id = $userId) is never
 * omitted.  Client-supplied identifiers are NEVER trusted as ownership proof.
 *
 * Access-control failures always return FORBIDDEN (never NOT_FOUND) to prevent
 * information leakage about resource existence to non-owners.
 *
 * Injectable: depends only on duck-typed interfaces for testability.
 */

import { deriveBookingPurgeAfter } from "@travel/retention";
import type { RetentionConfig } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Injectable Prisma interface — duck-typed for unit testability
// ---------------------------------------------------------------------------

export interface BookingRow {
  id: string;
  userId: string;
  status: string;
  bookingType: string;
  offerId: string;
  totalPrice: { toString(): string };
  currency: string;
  contactEmail: string;
  contactPhone?: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  /** WO-039: Immutable offer snapshot frozen at creation time. */
  offerSnapshot: Record<string, unknown>;
  /** WO-039: Supplier channel (AMADEUS | RAPIDAPI_HOTEL | RAPIDAPI_CAR). */
  provenance?: string | null;
  /** WO-039: Expiry timestamp for PENDING bookings (now + 30 min at create time). */
  expiresAt?: Date | null;
  /** WO-102: Purge date derived as created_at + transactionYears. Null before config injection. */
  purgeAfter?: Date | null;
  /** WO-102: Legal hold flag — when true, purge worker skips this row. */
  legalHold?: boolean;
}

export interface BookingPrismaClient {
  booking: {
    findFirst(args: {
      where: { id: string; userId: string } | { idempotencyKey: string };
    }): Promise<BookingRow | null>;
    findMany(args: {
      where: { userId: string };
      orderBy?: { createdAt: 'desc' | 'asc' };
      take?: number;
    }): Promise<BookingRow[]>;
    create(args: {
      data: {
        id?: string;
        userId: string;
        bookingType: string;
        status?: string;
        offerId: string;
        totalPrice: number | string;
        currency: string;
        contactEmail: string;
        contactPhone?: string | null;
        idempotencyKey: string;
        /** WO-039: Immutable offer snapshot frozen at creation time. */
        offerSnapshot?: Record<string, unknown>;
        /** WO-039: Supplier channel provenance. */
        provenance?: string | null;
        /** WO-039: PENDING expiry timestamp. */
        expiresAt?: Date | null;
        /** WO-102: Retention purge date derived from created_at + transactionYears. */
        purgeAfter?: Date | null;
        /** WO-102: Legal hold — defaults to false at creation. */
        legalHold?: boolean;
      };
    }): Promise<BookingRow>;
    update(args: {
      where: { id: string; userId: string };
      data: Partial<{ status: string; updatedAt: Date }>;
    }): Promise<BookingRow>;
  };
}

// ---------------------------------------------------------------------------
// Domain error thrown on ownership failure
// ---------------------------------------------------------------------------

export class OwnershipError extends Error {
  readonly code = 'FORBIDDEN' as const;
  constructor(resourceType: string, resourceId: string) {
    super(`Access denied to ${resourceType} ${resourceId}`);
    this.name = 'OwnershipError';
  }
}

// ---------------------------------------------------------------------------
// BookingRepository
// ---------------------------------------------------------------------------

export class BookingRepository {
  constructor(
    private readonly db: BookingPrismaClient,
    /**
     * WO-102: When provided, purge_after is derived at booking creation time
     * using deriveBookingPurgeAfter(createdAt, config). Optional to preserve
     * backwards compatibility with existing callers that do not pass config.
     */
    private readonly retentionConfig?: Pick<RetentionConfig, "transactionYears">,
  ) {}

  /**
   * Fetch a booking that belongs to the given user.
   *
   * The WHERE clause always includes BOTH the booking id AND the user id so
   * a pasted link from another user's booking returns null (→ 403), not the
   * row (→ ownership leak).
   *
   * @throws OwnershipError when the booking does not exist or belongs to
   *   a different user — callers must NOT distinguish between the two cases
   *   in the HTTP response (no 404-vs-403 information leak).
   */
  async findOwnedBookingOrThrow(
    bookingId: string,
    userId: string,
  ): Promise<BookingRow> {
    const booking = await this.db.booking.findFirst({
      where: { id: bookingId, userId },
    });

    if (!booking) {
      throw new OwnershipError('booking', bookingId);
    }

    return booking;
  }

  /**
   * List all bookings belonging to the given user.
   * Owner predicate applied in the query — no post-fetch filtering.
   */
  async findAllOwnedByUser(userId: string): Promise<BookingRow[]> {
    return this.db.booking.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cancel a booking that belongs to the given user.
   * Applies both id and userId predicates — non-owners get OwnershipError.
   */
  async cancelOwnedBooking(bookingId: string, userId: string): Promise<BookingRow> {
    // First verify ownership (throws OwnershipError if not owned)
    await this.findOwnedBookingOrThrow(bookingId, userId);

    return this.db.booking.update({
      where: { id: bookingId, userId },
      data: { status: 'CANCELLED' },
    });
  }

  // WO-039 additions ──────────────────────────────────────────────────────────

  /**
   * Create a new PENDING booking with an immutable offer snapshot.
   * Implements BookingRepositoryPort.createBooking.
   *
   * The offerSnapshot column is NOT NULL — callers must always supply the
   * resolved offer snapshot so the commercial record is frozen at insert time.
   * The update() method of BookingPrismaClient deliberately excludes
   * offerSnapshot from its data type so the snapshot cannot be mutated after
   * insertion (compile-time enforcement).
   */
  async createBooking(
    input: import("../domain/BookingCreationService.js").CreateBookingInput,
  ): Promise<import("../domain/BookingCreationService.js").CreatedBooking> {
    // WO-102: Derive purge_after at creation time when RetentionConfig is injected.
    // purge_after = created_at + transactionYears. We use now() as the creation
    // timestamp approximation; the DB-side @default(now()) will be within the same
    // transaction, so the delta is negligible for a 7-year horizon.
    const now = new Date();
    const purgeAfter = this.retentionConfig
      ? deriveBookingPurgeAfter(now, this.retentionConfig)
      : null;

    const row = await this.db.booking.create({
      data: {
        userId: input.userId,
        bookingType: input.bookingType,
        status: input.status,
        offerId: input.offerId,
        totalPrice: input.totalPrice,
        currency: input.currency,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone ?? null,
        idempotencyKey: input.idempotencyKey,
        offerSnapshot: input.offerSnapshot as Record<string, unknown>,
        provenance: input.provenance,
        expiresAt: input.expiresAt,
        // WO-102: Set purge_after and legal_hold at row creation time.
        purgeAfter,
        legalHold: false,
      },
    });

    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      totalPrice: row.totalPrice.toString(),
      currency: row.currency,
      expiresAt: row.expiresAt ?? null,
      provenance: row.provenance ?? null,
      offerSnapshot: row.offerSnapshot,
    };
  }

  /**
   * Look up a booking by its idempotency key for duplicate-create detection.
   * Returns null if no booking was created with this key yet.
   */
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<import("../domain/BookingCreationService.js").CreatedBooking | null> {
    const row = await this.db.booking.findFirst({
      where: { idempotencyKey },
    });

    if (!row) return null;

    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      totalPrice: row.totalPrice.toString(),
      currency: row.currency,
      expiresAt: row.expiresAt ?? null,
      provenance: row.provenance ?? null,
      offerSnapshot: row.offerSnapshot,
    };
  }
}
