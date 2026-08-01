/**
 * BookingLifecycleService — the single, mandatory gateway for every booking
 * status mutation (WO-040).
 *
 * Contract:
 *   transition(bookingId, targetStatus, actor, reason?) → TransitionResult
 *
 * Guarantees (all enforced atomically):
 *   1. Validates against the explicit transition matrix in transitions.ts.
 *   2. Writes a conditional DB update (WHERE id = $id AND status = $fromStatus)
 *      — a zero-rowsAffected result means a lost race → 409 LIFECYCLE_CONFLICT.
 *   3. Writes an audit row in the SAME database transaction as the status
 *      update so state and audit can never diverge.
 *   4. Same-status calls for idempotent states succeed without a new audit row.
 *   5. Unknown or unmapped statuses are refused with 409 (deny by default).
 *
 * Injectable: no Prisma, Express, or clock imports at the top level.
 * Collaborators are injected via the constructor.
 */

import { lifecycleConflict, notFound } from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";
import {
  isPermittedTransition,
  isKnownStatus,
  IDEMPOTENT_STATUSES,
  PERMITTED_TRANSITIONS,
  type BookingStatus,
} from "./transitions.js";
import type { AuditTxClient } from "./AuditWriter.js";
import { writeAudit } from "./AuditWriter.js";

// ---------------------------------------------------------------------------
// Actor context
// ---------------------------------------------------------------------------

export interface LifecycleActor {
  /** Authenticated user ID or system identifier (e.g. "payment-service"). */
  id: string;
  /** Role of the actor triggering the transition. */
  role: string;
}

// ---------------------------------------------------------------------------
// Port interfaces — all dependencies are injected
// ---------------------------------------------------------------------------

/**
 * Minimal booking row needed by the lifecycle guard.
 * Only id and status are required; callers needing the full row must query
 * the BookingRepository directly.
 */
export interface BookingStatusRow {
  id: string;
  status: string;
}

/**
 * Repository operations the lifecycle service needs.
 *
 * Concrete implementation: BookingRepository.
 * Test doubles can be plain objects satisfying this interface.
 */
export interface LifecycleRepositoryPort {
  /**
   * Find a booking by ID without an ownership predicate.
   * Returns null when not found (lifecycle service maps this to 404).
   */
  findBookingById(bookingId: string): Promise<BookingStatusRow | null>;

  /**
   * Perform a conditional status update inside an open transaction.
   *
   * Executes: UPDATE bookings SET status=$toStatus WHERE id=$bookingId AND
   * status=$fromStatus.
   *
   * Returns the number of rows updated (0 means lost race).
   */
  conditionalStatusUpdate(
    bookingId: string,
    fromStatus: string,
    toStatus: string,
    tx: AuditTxClient,
  ): Promise<number>;

  /**
   * Open a Prisma interactive transaction and call `work` inside it.
   * If `work` throws, the transaction is rolled back automatically.
   */
  runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T>;
}

/** Minimal clock injectable for deterministic tests. */
export type LifecycleClock = () => Date;

/** Minimal structured logger (pino-compatible subset). */
export interface LifecycleLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface TransitionResult {
  bookingId: string;
  previousStatus: string;
  newStatus: string;
  /** True when the booking was already in targetStatus — no audit row written. */
  idempotent: boolean;
}

// ---------------------------------------------------------------------------
// BookingLifecycleService
// ---------------------------------------------------------------------------

export interface LifecycleDeps {
  repository: LifecycleRepositoryPort;
  clock?: LifecycleClock;
  log?: LifecycleLogger;
}

export class BookingLifecycleService {
  private readonly repo: LifecycleRepositoryPort;
  private readonly clock: LifecycleClock;
  private readonly log: LifecycleLogger | undefined;

  constructor(deps: LifecycleDeps) {
    this.repo = deps.repository;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  /**
   * Transition `bookingId` to `targetStatus`.
   *
   * @throws {DomainError} NOT_FOUND (404) when the booking does not exist.
   * @throws {DomainError} LIFECYCLE_CONFLICT (409) for:
   *   - Disallowed transition pair.
   *   - Unknown / unmapped current or target status.
   *   - Lost concurrent update race (zero rowsAffected).
   */
  async transition(
    bookingId: string,
    targetStatus: string,
    actor: LifecycleActor,
    reason?: string,
  ): Promise<TransitionResult> {
    // AC7: unknown target status → refuse before touching the DB.
    if (!isKnownStatus(targetStatus)) {
      throw lifecycleConflict(
        `Unknown target status "${targetStatus}". ` +
          `Known statuses: ${Object.keys(PERMITTED_TRANSITIONS).join(", ")}.`,
      );
    }

    const booking = await this.repo.findBookingById(bookingId);
    if (!booking) {
      throw notFound(`Booking "${bookingId}" not found.`);
    }

    const currentStatus = booking.status;

    // AC7: unknown current status → refuse (deny by default).
    if (!isKnownStatus(currentStatus)) {
      throw lifecycleConflict(
        `Booking "${bookingId}" has unknown status "${currentStatus}". ` +
          `Transition refused.`,
      );
    }

    // AC4: same-status idempotency — return without audit row.
    if (currentStatus === targetStatus) {
      if (IDEMPOTENT_STATUSES.has(currentStatus as BookingStatus)) {
        this.log?.info(
          { bookingId, status: currentStatus, actorId: actor.id, actorRole: actor.role },
          "Idempotent transition: booking already in target status",
        );
        return {
          bookingId,
          previousStatus: currentStatus,
          newStatus: targetStatus,
          idempotent: true,
        };
      }
      // Non-idempotent same-status (e.g. PENDING→PENDING) is a conflict.
      throw lifecycleConflict(
        `Booking "${bookingId}" is already ${currentStatus}. ` +
          `Same-status transition is not idempotent for this state.`,
      );
    }

    // AC2: validate against the permitted transition matrix.
    if (!isPermittedTransition(currentStatus as BookingStatus, targetStatus as BookingStatus)) {
      const permitted = PERMITTED_TRANSITIONS[currentStatus as BookingStatus];
      const permittedList = permitted && permitted.length > 0 ? permitted.join(", ") : "none";
      this.log?.warn(
        {
          bookingId,
          fromStatus: currentStatus,
          toStatus: targetStatus,
          actorId: actor.id,
          actorRole: actor.role,
          reason,
        },
        "Booking lifecycle transition refused",
      );
      throw lifecycleConflict(
        `Booking "${bookingId}" is ${currentStatus}; permitted transitions are [${permittedList}].`,
      );
    }

    const now = this.clock();

    // AC5/AC6: conditional update + audit row in one transaction.
    await this.repo.runInTransaction(async (tx) => {
      const rowsAffected = await this.repo.conditionalStatusUpdate(
        bookingId,
        currentStatus,
        targetStatus,
        tx,
      );

      // AC5: zero rows → lost race → 409.
      if (rowsAffected === 0) {
        throw lifecycleConflict(
          `Booking "${bookingId}" status changed concurrently. ` +
            `Expected status was "${currentStatus}". Retry the request.`,
        );
      }

      // AC6: audit row in the same transaction.
      await writeAudit({
        tx,
        bookingId,
        action: `STATUS_CHANGED_TO_${targetStatus}`,
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "booking",
        resourceId: bookingId,
        occurredAt: now,
        payload: {
          previousStatus: currentStatus,
          newStatus: targetStatus,
          reason: reason ?? null,
        },
      });
    });

    this.log?.info(
      {
        bookingId,
        fromStatus: currentStatus,
        toStatus: targetStatus,
        actorId: actor.id,
        actorRole: actor.role,
        reason,
      },
      "Booking lifecycle transition committed",
    );

    return {
      bookingId,
      previousStatus: currentStatus,
      newStatus: targetStatus,
      idempotent: false,
    };
  }
}

// ---------------------------------------------------------------------------
// LifecycleConflictError — re-exported for instanceof checks in controllers
// ---------------------------------------------------------------------------

/**
 * Type-guard helper: returns true when `err` is a DomainError with code
 * LIFECYCLE_CONFLICT.  Use this instead of instanceof so callers don't
 * need to import the private DomainErrorImpl class.
 */
export function isLifecycleConflict(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as DomainError).code === "LIFECYCLE_CONFLICT"
  );
}
