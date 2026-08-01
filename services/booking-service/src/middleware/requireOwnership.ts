/**
 * requireOwnership — express middleware that enforces booking ownership
 * using BookingEntitlementService (WO-044).
 *
 * This is the SECOND line of defence (after requireRole).  Removing this
 * middleware alone cannot expose data, because the domain-layer entitlement
 * check runs independently inside the route handler.  Both layers must pass
 * before any booking data is returned.
 *
 * The middleware:
 *   1. Extracts actor from req.actor (set by actorContextVerifier).
 *   2. Loads the booking's ownerId from the repository (no ownership predicate yet).
 *   3. Calls BookingEntitlementService.canRead / canModify / canCancel.
 *   4. On DENY: writes a security event and returns 403.
 *   5. On ALLOW: attaches the ownerId to req for downstream handlers and calls next().
 *
 * Usage:
 *   router.get('/:bookingId', requireRole('traveler', 'support_agent'),
 *                             requireOwnership('READ', bookingRepo, entitlementService, securityWriter),
 *                             handler)
 */

import type { Request, Response, NextFunction } from "express";
import type { BookingEntitlementService } from "../domain/BookingEntitlementService.js";
import type { SecurityEventWriter } from "../domain/SecurityEventWriter.js";

// ---------------------------------------------------------------------------
// Injectable port — minimal booking-row shape needed for ownership check
// ---------------------------------------------------------------------------

export interface OwnershipBookingPort {
  /**
   * Find a booking by id with NO ownership predicate.
   * Returns null when the booking does not exist (→ 404).
   * Used ONLY to retrieve ownerId for the entitlement check.
   */
  findBookingById(bookingId: string): Promise<{ id: string; ownerId: string } | null>;
}

// ---------------------------------------------------------------------------
// Operation type
// ---------------------------------------------------------------------------

export type BookingOperation = "READ" | "MODIFY" | "CANCEL";

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that enforces booking ownership for the
 * specified operation type.
 *
 * @param operation   - The operation being attempted (READ, MODIFY, CANCEL).
 * @param ownershipRepo - Port for fetching booking ownerId.
 * @param entitlement - BookingEntitlementService instance.
 * @param securityWriter - For immutable denial audit trail.
 */
export function requireOwnership(
  operation: BookingOperation,
  ownershipRepo: OwnershipBookingPort,
  entitlement: BookingEntitlementService,
  securityWriter?: SecurityEventWriter,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function requireOwnershipMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
    const correlationId = (req as Request & { correlationId?: string }).correlationId;
    const { bookingId } = (req as Request & { params: Record<string, string> }).params;

    if (!actor) {
      res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
        reference: correlationId,
      });
      return;
    }

    if (!bookingId) {
      // No bookingId in params — let the route handler deal with it
      next();
      return;
    }

    // Load booking owner — no ownership predicate here, just ownerId lookup
    const booking = await ownershipRepo.findBookingById(bookingId);
    if (!booking) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Booking not found" },
        reference: correlationId,
      });
      return;
    }

    const actorContext = {
      id: actor.sub,
      role: actor.roles[0] ?? "unknown",
    };

    let decision;
    if (operation === "READ") {
      decision = entitlement.canRead(actorContext, { ownerId: booking.ownerId });
    } else if (operation === "MODIFY") {
      decision = entitlement.canModify(actorContext, { ownerId: booking.ownerId });
    } else {
      decision = entitlement.canCancel(actorContext, { ownerId: booking.ownerId });
    }

    if (!decision.allowed) {
      // Write immutable security event — failure here is a compliance error, propagate
      if (securityWriter) {
        await securityWriter.write({
          actorId: actor.sub,
          actorRole: actor.roles[0] ?? "unknown",
          resourceType: "booking",
          resourceId: bookingId,
          operation,
          decision: "DENY",
          reason: decision.reason,
        });
      }

      res.status(403).json({
        error: { code: "FORBIDDEN", message: "Access denied" },
        reference: correlationId,
      });
      return;
    }

    // Attach ownerId so route handlers don't need to re-fetch
    (req as Request & { bookingOwnerId?: string }).bookingOwnerId = booking.ownerId;
    next();
  };
}
