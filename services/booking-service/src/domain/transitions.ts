/**
 * transitions.ts — single authoritative source for the booking lifecycle
 * transition matrix (WO-040).
 *
 * BookingLifecycleService, BookingStateMachine, and any future lifecycle
 * component MUST import from here so there is exactly one copy of the graph.
 *
 * Design decisions:
 *   - All statuses are exhaustively listed so adding a new value is a compile
 *     error on the Record key rather than a silent omission.
 *   - Terminal states have an empty permitted set; the guard denies by default
 *     so an unknown or newly-added status is refused, not passed through.
 *   - COMPLETED is included here because AC2 (WO-040) mandates CONFIRMED →
 *     COMPLETED as a required transition.
 */

// ---------------------------------------------------------------------------
// BookingStatus — canonical string union
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "REFUNDED"
  | "EXPIRED";

// ---------------------------------------------------------------------------
// Permitted transition matrix
// ---------------------------------------------------------------------------

/**
 * Exhaustive mapping: every BookingStatus → the statuses it may advance to.
 *
 * AC2 (WO-040) required pairs:
 *   PENDING    → CONFIRMED | CANCELLED | EXPIRED
 *   CONFIRMED  → COMPLETED | CANCELLED
 *
 * Additional pairs carried over from saga and payment flows:
 *   PENDING    → FAILED     (saga compensation after supplier rejection)
 *   CONFIRMED  → REFUNDED   (upstream refund webhook)
 *
 * Terminal states (COMPLETED, CANCELLED, FAILED, REFUNDED, EXPIRED) have
 * empty sets — no further transitions are ever permitted.
 */
export const PERMITTED_TRANSITIONS: Readonly<Record<BookingStatus, ReadonlyArray<BookingStatus>>> = {
  PENDING:   ["CONFIRMED", "CANCELLED", "FAILED", "EXPIRED"],
  CONFIRMED: ["COMPLETED", "CANCELLED", "REFUNDED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED:    [],
  REFUNDED:  [],
  EXPIRED:   [],
} as const;

// ---------------------------------------------------------------------------
// Set of statuses where same-status calls are idempotent (AC4 WO-040)
// ---------------------------------------------------------------------------

/**
 * A same-status call for any status in this set succeeds without writing a
 * duplicate audit row and returns the existing booking state.
 *
 * Rationale: CONFIRMED and CANCELLED are the two states where a retry or a
 * late duplicate webhook may arrive; treating them as already-done avoids
 * both duplicate audit rows and false 409s.  EXPIRED is included because
 * the expiry sweep may fire twice; other terminal states are not idempotent
 * because a FAILED booking re-failing is abnormal and should be examined.
 */
export const IDEMPOTENT_STATUSES = new Set<BookingStatus>(["CONFIRMED", "CANCELLED", "EXPIRED"]);

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `from` → `to` is in the permitted set.
 * Denies by default: an unknown `from` has no entry in the map → false.
 */
export function isPermittedTransition(from: BookingStatus, to: BookingStatus): boolean {
  const permitted = PERMITTED_TRANSITIONS[from];
  return permitted !== undefined && (permitted as BookingStatus[]).includes(to);
}

/**
 * Returns true when `status` is a terminal state (no outgoing transitions).
 * An unknown status is treated as terminal (deny by default).
 */
export function isTerminalStatus(status: BookingStatus): boolean {
  const permitted = PERMITTED_TRANSITIONS[status];
  return permitted !== undefined && permitted.length === 0;
}

/**
 * Returns true when `value` is a known BookingStatus.
 * Used by the lifecycle guard to detect unknown/unmapped values before
 * looking them up in the transition matrix.
 */
export function isKnownStatus(value: string): value is BookingStatus {
  return Object.prototype.hasOwnProperty.call(PERMITTED_TRANSITIONS, value);
}
