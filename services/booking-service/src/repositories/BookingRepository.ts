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
import type { AuditTxClient } from "../domain/AuditWriter.js";
import type { LifecycleRepositoryPort, BookingStatusRow } from "../domain/BookingLifecycleService.js";
import type {
  RevalidationRepositoryPort,
  RevalidationBookingRow,
  ConsentRecord,
} from "../domain/PriceRevalidationService.js";

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
  /** WO-042: Re-validated offer snapshot from supplier re-price call. Null until revalidated. */
  revalidatedSnapshot?: Record<string, unknown> | null;
  /** WO-042: Deadline after which the booking is no longer payable. Null until validated. */
  payableUntil?: Date | null;
}

export interface BookingPrismaClient {
  booking: {
    findFirst(args: {
      where: { id: string; userId: string } | { idempotencyKey: string } | { id: string };
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
    /**
     * WO-040: Conditional update for optimistic concurrency.
     * WHERE clause includes the expected current status so two concurrent
     * callers cannot both succeed — the second returns count: 0.
     */
    updateMany(args: {
      where: { id: string; status: string };
      data: { status: string; updatedAt: Date };
    }): Promise<{ count: number }>;

    /**
     * WO-042: Update revalidation fields on a booking row.
     */
    update(args: {
      where: { id: string };
      data: {
        revalidatedSnapshot?: Record<string, unknown> | null;
        payableUntil?: Date | null;
        updatedAt?: Date;
      };
    }): Promise<BookingRow>;
  };

  /**
   * WO-042: booking_price_consents table operations.
   */
  bookingPriceConsent: {
    create(args: {
      data: {
        bookingId: string;
        previousTotal: number | string;
        acceptedTotal: number | string;
        currency: string;
        actorId: string;
        acceptedAt: Date;
        correlationId?: string | null;
      };
    }): Promise<unknown>;
  };

  /**
   * WO-040: Prisma interactive transaction.
   * Passes a transaction-scoped client to `fn`; rolls back if `fn` throws.
   * The tx client satisfies both BookingPrismaClient (for status update) and
   * AuditTxClient (for audit row insert) shapes.
   */
  $transaction<T>(
    fn: (tx: BookingPrismaClient & AuditTxClient) => Promise<T>,
  ): Promise<T>;
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
// BookingRepository implements both CRUD and LifecycleRepositoryPort
// ---------------------------------------------------------------------------

export class BookingRepository implements LifecycleRepositoryPort, RevalidationRepositoryPort {
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

  // WO-040 lifecycle port methods ─────────────────────────────────────────────

  /**
   * Find a booking by its ID without an ownership predicate.
   * Used exclusively by BookingLifecycleService for status-transition guards.
   * Callers performing user-facing reads MUST use findOwnedBookingOrThrow.
   */
  async findBookingById(bookingId: string): Promise<BookingStatusRow | null> {
    const row = await this.db.booking.findFirst({
      where: { id: bookingId },
    });
    if (!row) return null;
    return { id: row.id, status: row.status };
  }

  /**
   * Conditional status update for optimistic concurrency (AC5 WO-040).
   *
   * Uses updateMany with WHERE id=$bookingId AND status=$fromStatus.
   * Returns the number of rows updated:
   *   1 → success (transition committed)
   *   0 → lost race; the row's status changed between the findBookingById
   *       call and this update — the caller must surface this as 409.
   *
   * Must be called inside a transaction (tx parameter is the
   * transaction-scoped client so the update and the audit row are atomic).
   *
   * NOTE: `tx` is typed as AuditTxClient for the audit write; the underlying
   * concrete Prisma tx client also satisfies the booking update shape.
   * The implementation casts to the full db type so both operations share
   * the same transaction.
   */
  async conditionalStatusUpdate(
    bookingId: string,
    fromStatus: string,
    toStatus: string,
    tx: AuditTxClient,
  ): Promise<number> {
    const dbTx = tx as unknown as BookingPrismaClient;
    const result = await dbTx.booking.updateMany({
      where: { id: bookingId, status: fromStatus },
      data: { status: toStatus, updatedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Open a Prisma interactive transaction and run `work` inside it (AC6 WO-040).
   * If `work` throws, the transaction is automatically rolled back.
   *
   * The transaction client satisfies BookingPrismaClient (booking.updateMany)
   * AND AuditTxClient (bookingAuditLog.create) so both operations share the
   * same connection and commit atomically.
   */
  async runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T> {
    return this.db.$transaction((tx) => work(tx as unknown as AuditTxClient));
  }

  // WO-042 revalidation port methods ─────────────────────────────────────────

  /**
   * Find a booking by ID for price re-validation (no ownership predicate).
   * Used exclusively by PriceRevalidationService.
   */
  async findBookingForRevalidation(bookingId: string): Promise<RevalidationBookingRow | null> {
    const row = await this.db.booking.findFirst({ where: { id: bookingId } });
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      totalPrice: row.totalPrice.toString(),
      currency: row.currency,
      offerSnapshot: row.offerSnapshot as Record<string, unknown>,
      revalidatedSnapshot: (row.revalidatedSnapshot as Record<string, unknown> | null) ?? null,
      payableUntil: row.payableUntil ?? null,
    };
  }

  /**
   * Persist the re-validated offer snapshot and the payment deadline on the
   * booking row.  Called both when price is unchanged (payableUntil = now + 15m)
   * and as an intermediate step when price changed (payableUntil = epoch 0,
   * meaning NOT payable until consent is given).
   */
  async saveRevalidationResult(
    bookingId: string,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
  ): Promise<void> {
    const isPayable = payableUntil.getTime() > 0;
    await this.db.booking.update({
      where: { id: bookingId },
      data: {
        revalidatedSnapshot,
        payableUntil: isPayable ? payableUntil : null,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Persist the consent record and mark the booking payable inside the same
   * Prisma transaction that also writes the PRICE_ACCEPTED audit row.
   *
   * The `tx` parameter is the transaction-scoped Prisma client cast to
   * AuditTxClient (for the audit write in the service layer).  The concrete
   * implementation casts it back to the full client type for booking/consent
   * writes.
   */
  async saveConsentAndMarkPayable(
    consent: ConsentRecord,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
    tx: AuditTxClient,
  ): Promise<void> {
    const dbTx = tx as unknown as BookingPrismaClient;
    await dbTx.bookingPriceConsent.create({
      data: {
        bookingId: consent.bookingId,
        previousTotal: consent.previousTotal,
        acceptedTotal: consent.acceptedTotal,
        currency: consent.currency,
        actorId: consent.actorId,
        acceptedAt: consent.acceptedAt,
        correlationId: consent.correlationId ?? null,
      },
    });
    await dbTx.booking.update({
      where: { id: consent.bookingId },
      data: {
        revalidatedSnapshot,
        payableUntil,
        updatedAt: new Date(),
      },
    });
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
