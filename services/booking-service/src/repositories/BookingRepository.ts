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
}

export interface BookingPrismaClient {
  booking: {
    findFirst(args: {
      where: { id: string; userId: string };
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
  constructor(private readonly db: BookingPrismaClient) {}

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
}
