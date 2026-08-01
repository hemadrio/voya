/**
 * BookingEntitlementService — pure domain entitlement checks (WO-044).
 *
 * Derives canRead, canModify and canCancel from actor role + ownership
 * metadata.  This module has no I/O dependencies; it is a pure function
 * layer so it can be exhaustively unit-tested without any DB or HTTP setup.
 *
 * The service is the SECOND line of defence:
 *   First line  — requireRole middleware (declarative, route-level)
 *   Second line — BookingEntitlementService (domain-level, per-operation)
 *
 * Removing the middleware alone CANNOT expose data, because the domain check
 * runs independently and denies unentitled actors even without the middleware.
 *
 * Role semantics:
 *   traveler      — may read, modify and cancel only their OWN bookings.
 *   support_agent — may read and cancel ANY booking; may never modify traveler
 *                   identity documents (enforced by PatchBookingRequest schema
 *                   which is blocked for support_agents at the route level).
 *   system        — may NOT access traveler-facing read/modify/cancel routes;
 *                   the system role is scoped to queue and job operations only.
 *   unknown       — denied for every operation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntitlementActor {
  id: string;
  role: string;
}

export interface BookingOwnershipMeta {
  /** The userId stored on the booking row. */
  ownerId: string;
}

export type EntitlementDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// BookingEntitlementService
// ---------------------------------------------------------------------------

export class BookingEntitlementService {
  /**
   * Decide whether the actor may READ the given booking.
   *
   * - traveler: only their own booking.
   * - support_agent: any booking.
   * - system: denied (system operates via queue, never user-facing reads).
   * - unknown role: denied.
   */
  canRead(actor: EntitlementActor, meta: BookingOwnershipMeta): EntitlementDecision {
    switch (actor.role) {
      case "traveler":
        if (actor.id === meta.ownerId) return { allowed: true };
        return { allowed: false, reason: "OWNERSHIP_PREDICATE_FAILED" };

      case "support_agent":
        return { allowed: true };

      case "system":
        return { allowed: false, reason: "SYSTEM_ROLE_NOT_PERMITTED_ON_READ_ENDPOINT" };

      default:
        return { allowed: false, reason: `UNKNOWN_ROLE:${actor.role}` };
    }
  }

  /**
   * Decide whether the actor may MODIFY the given booking.
   *
   * Only the booking's owner (traveler) may modify.
   * support_agent may NOT modify (to protect identity-document integrity).
   * system: denied.
   */
  canModify(actor: EntitlementActor, meta: BookingOwnershipMeta): EntitlementDecision {
    switch (actor.role) {
      case "traveler":
        if (actor.id === meta.ownerId) return { allowed: true };
        return { allowed: false, reason: "OWNERSHIP_PREDICATE_FAILED" };

      case "support_agent":
        return { allowed: false, reason: "SUPPORT_AGENT_CANNOT_MODIFY" };

      case "system":
        return { allowed: false, reason: "SYSTEM_ROLE_NOT_PERMITTED_ON_MODIFY_ENDPOINT" };

      default:
        return { allowed: false, reason: `UNKNOWN_ROLE:${actor.role}` };
    }
  }

  /**
   * Decide whether the actor may CANCEL the given booking.
   *
   * - traveler: only their own booking.
   * - support_agent: any booking (e.g. complaint resolution).
   * - system: denied on user-facing cancel; the sweep uses the lifecycle guard directly.
   * - unknown role: denied.
   */
  canCancel(actor: EntitlementActor, meta: BookingOwnershipMeta): EntitlementDecision {
    switch (actor.role) {
      case "traveler":
        if (actor.id === meta.ownerId) return { allowed: true };
        return { allowed: false, reason: "OWNERSHIP_PREDICATE_FAILED" };

      case "support_agent":
        return { allowed: true };

      case "system":
        return { allowed: false, reason: "SYSTEM_ROLE_NOT_PERMITTED_ON_CANCEL_ENDPOINT" };

      default:
        return { allowed: false, reason: `UNKNOWN_ROLE:${actor.role}` };
    }
  }
}
