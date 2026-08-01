/**
 * BookingCommandPort — internal HTTP adapter for booking lifecycle commands.
 *
 * The payment service cannot share a Prisma transaction with the booking
 * service (separate DBs / containers), so cross-service state transitions
 * are effected by HTTP calls to the booking service's internal API.
 *
 * Idempotency contract (BR-03):
 *   Every call carries the Stripe event ID as an idempotencyToken so a
 *   retried HTTP call cannot produce a second CONFIRMED transition.  The
 *   booking service uses this token for its own internal deduplication
 *   (see booking-service/src/domain/BookingLifecycleService.ts).
 *
 * Injectable: tests supply in-memory fakes without running the booking
 * service.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CANCELLED"
  | "EXPIRED"
  | "MODIFIED";

/** Minimal booking view returned by getBookingStatus. */
export interface BookingView {
  bookingId: string;
  status: BookingStatus;
  userId: string;
}

/** Result of a successful booking transition. */
export interface BookingTransitionResult {
  bookingId: string;
  status: BookingStatus;
  userId: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface BookingCommandPort {
  /**
   * Fetch the current booking status (read-only).
   * Used before opening the DB transaction to check for terminal states.
   */
  getBookingStatus(bookingId: string): Promise<BookingView>;

  /**
   * Transition the booking to CONFIRMED using the given idempotency token.
   *
   * Idempotent: if the booking is already CONFIRMED the call succeeds
   * (the booking-service checks the token and returns the current state).
   *
   * @param idempotencyToken - Stripe event ID; re-used across retries.
   * @throws when the booking does not exist or the state machine refuses
   *   the transition (e.g. CANCELLED → CONFIRMED is illegal).
   */
  transitionToConfirmed(
    bookingId: string,
    idempotencyToken: string,
  ): Promise<BookingTransitionResult>;
}

// ---------------------------------------------------------------------------
// InMemoryBookingCommandPort — deterministic in-memory implementation
// ---------------------------------------------------------------------------

export type MockBookingState = {
  status: BookingStatus;
  userId: string;
};

/**
 * In-memory fake for unit tests.
 *
 * Pre-populate with booking states; transitionToConfirmed() updates the
 * stored status and records the call so tests can assert exactly-once.
 */
export class InMemoryBookingCommandPort implements BookingCommandPort {
  /** bookingId → mutable state */
  readonly bookings = new Map<string, MockBookingState>();

  /** Recorded (bookingId, idempotencyToken) calls */
  readonly transitionCalls: Array<{ bookingId: string; idempotencyToken: string }> = [];

  addBooking(bookingId: string, status: BookingStatus, userId = "user-00000000-0000-0000-0000-000000000001"): this {
    this.bookings.set(bookingId, { status, userId });
    return this;
  }

  async getBookingStatus(bookingId: string): Promise<BookingView> {
    const state = this.bookings.get(bookingId);
    if (!state) {
      throw Object.assign(new Error(`Booking ${bookingId} not found`), { code: "NOT_FOUND" });
    }
    return { bookingId, status: state.status, userId: state.userId };
  }

  async transitionToConfirmed(
    bookingId: string,
    idempotencyToken: string,
  ): Promise<BookingTransitionResult> {
    const state = this.bookings.get(bookingId);
    if (!state) {
      throw Object.assign(new Error(`Booking ${bookingId} not found`), { code: "NOT_FOUND" });
    }

    this.transitionCalls.push({ bookingId, idempotencyToken });

    // Idempotent: already CONFIRMED is a no-op
    if (state.status !== "CONFIRMED") {
      state.status = "CONFIRMED";
    }

    return { bookingId, status: state.status, userId: state.userId };
  }
}
