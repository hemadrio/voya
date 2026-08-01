/**
 * BookingStateMachine — enforces booking lifecycle transitions.
 *
 * All state definitions and the permitted transition matrix live in
 * transitions.ts (WO-040 single source of truth).  This module re-exports
 * the public API surface so existing callers do not need to change their
 * import paths.
 *
 * New code should prefer importing from BookingLifecycleService.ts (the domain
 * service that persists the transition) rather than calling assertTransition
 * directly, since calling assertTransition alone does not write the audit row
 * or perform the conditional DB update.
 */

import { lifecycleConflict } from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";
import {
  isPermittedTransition,
  PERMITTED_TRANSITIONS,
} from "./transitions.js";

export type { BookingStatus } from "./transitions.js";
export { PERMITTED_TRANSITIONS, isTerminalStatus as isTerminal } from "./transitions.js";

/**
 * Assert that the transition from `current` to `next` is permitted.
 *
 * @throws {DomainError} LIFECYCLE_CONFLICT (409) when the transition is
 * forbidden. The message names the current state and the permitted next states.
 */
export function assertTransition(current: string, next: string): void {
  const permitted = PERMITTED_TRANSITIONS[current as keyof typeof PERMITTED_TRANSITIONS];
  if (!permitted || !(permitted as string[]).includes(next)) {
    const permittedList =
      permitted && permitted.length > 0 ? permitted.join(", ") : "none";
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
  current: string,
  next: string,
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
export function getPermittedTransitions(current: string): ReadonlyArray<string> {
  return PERMITTED_TRANSITIONS[current as keyof typeof PERMITTED_TRANSITIONS] ?? [];
}

/** Returns true when `status` is a terminal state that accepts no transitions. */
export function isTerminal(status: string): boolean {
  return !isPermittedTransition || getPermittedTransitions(status).length === 0;
}
