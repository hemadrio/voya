/**
 * BookingStateMachine — enforces booking lifecycle transitions.
 *
 * A booking may only advance along permitted edges. Any attempted move to a
 * state not reachable from the current state raises a LIFECYCLE_CONFLICT (409)
 * that names the current state and the permitted next states so callers can act
 * on it without guessing the graph.
 *
 * Terminal states (COMPLETED, CANCELLED, FAILED, REFUNDED, EXPIRED) accept no
 * further transitions — a webhook arriving for an already-cancelled booking
 * is rejected here before it can resurrect the record.
 */

import { lifecycleConflict } from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";

// ---------------------------------------------------------------------------
// State vocabulary
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
// Transition graph
// ---------------------------------------------------------------------------

/**
 * Exhaustive mapping of every status to the set of statuses it may transition
 * into. Terminal states have an empty permitted set.
 */
export const PERMITTED_TRANSITIONS: Readonly<Record<BookingStatus, ReadonlyArray<BookingStatus>>> = {
  PENDING: ["CONFIRMED", "FAILED", "CANCELLED", "EXPIRED"],
  CONFIRMED: ["COMPLETED", "CANCELLED", "REFUNDED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
  REFUNDED: [],
  EXPIRED: [],
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assert that the transition from `current` to `next` is permitted.
 *
 * @throws {DomainError} LIFECYCLE_CONFLICT (409) when the transition is
 * forbidden. The message names the current state and the permitted next states.
 */
export function assertTransition(current: BookingStatus, next: BookingStatus): void {
  const permitted = PERMITTED_TRANSITIONS[current];
  if (!permitted.includes(next)) {
    const permittedList = permitted.length > 0 ? permitted.join(", ") : "none";
    throw lifecycleConflict(
      `Cannot transition booking from ${current} to ${next}. ` +
        `Current state: ${current}. Permitted transitions: [${permittedList}].`,
    );
  }
}

/**
 * Non-throwing variant — returns a DomainError when the transition is
 * forbidden, or null when it is permitted.
 */
export function checkTransition(
  current: BookingStatus,
  next: BookingStatus,
): DomainError | null {
  try {
    assertTransition(current, next);
    return null;
  } catch (err) {
    return err as DomainError;
  }
}

/**
 * Returns the list of states reachable from `current`.
 * An empty array means `current` is a terminal state.
 */
export function getPermittedTransitions(current: BookingStatus): ReadonlyArray<BookingStatus> {
  return PERMITTED_TRANSITIONS[current];
}

/** Returns true when `status` is a terminal state that accepts no transitions. */
export function isTerminal(status: BookingStatus): boolean {
  return PERMITTED_TRANSITIONS[status].length === 0;
}
