/**
 * Booking service routes — create, read, cancel.
 *
 * Authorization:
 *   - All routes require an authenticated actor (requireRole guard).
 *   - traveler: create, read own bookings, cancel own bookings.
 *   - support_agent: read and cancel any booking (no identity-doc access).
 *   - system: no access to booking routes (system operates via queue only).
 *
 * Ownership:
 *   - traveler reads/cancels go through BookingRepository.findOwnedBookingOrThrow
 *     which includes BOTH id AND userId predicates; non-owners get 403 (never 404).
 *   - support_agent reads by booking id but NEVER loads identity-document
 *     columns (enforced in the repository projection layer).
 *
 * Security events:
 *   - OwnershipError (403) emits an immutable security event.
 *   - Audit write failures propagate as 500 (compliance requirement).
 *
 * Idempotency-key header is validated before CreateBookingRequest body so
 * the header presence is asserted at the schema boundary.
 */
import { Router } from "express";
import { z } from "zod";
import { CreateBookingRequestSchema, identifier } from "@travel/contracts";
import { requireRole, registerRouteGuard } from "@travel/auth";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";
import type { SecurityEventWriter } from "../domain/SecurityEventWriter.js";
import type { BookingRepository } from "../repositories/BookingRepository.js";
import { OwnershipError } from "../repositories/BookingRepository.js";

// Compiled once at module scope.
const BookingIdParamsSchema = z.object({ bookingId: identifier });
const IdempotencyHeaderSchema = z.object({
  "idempotency-key": z.string().min(1, "Idempotency-Key header is required"),
}).passthrough();

const validateCreate = validateRequest({
  headers: IdempotencyHeaderSchema,
  body: CreateBookingRequestSchema,
});
const validateBookingId = validateRequest({ params: BookingIdParamsSchema });

export interface BookingDomain {
  create(idempotencyKey: string, body: unknown, userId: string): Promise<unknown>;
  getById(bookingId: string, actorId: string, actorRole: string): Promise<unknown>;
  cancel(bookingId: string, actorId: string, actorRole: string): Promise<unknown>;
}

// Register route guards in the global registry (for startup assertion + tests)
registerRouteGuard('POST', '/', 'requireRole', ['traveler']);
registerRouteGuard('GET', '/:bookingId', 'requireRole', ['traveler', 'support_agent']);
registerRouteGuard('POST', '/:bookingId/cancel', 'requireRole', ['traveler', 'support_agent']);

export function createBookingRouter(
  domain: BookingDomain,
  securityEventWriter?: SecurityEventWriter,
  bookingRepo?: BookingRepository,
): Router {
  const router = Router();

  // Helper: emit security event and return 403
  async function denyWithAudit(
    res: Response,
    req: Request,
    resourceType: string,
    resourceId: string,
    operation: string,
    reason: string,
  ): Promise<void> {
    const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
    if (securityEventWriter && actor) {
      // Audit write failure must not be swallowed — rethrow as 500
      await securityEventWriter.write({
        actorId: actor.sub,
        actorRole: actor.roles[0] ?? 'unknown',
        resourceType,
        resourceId,
        operation,
        decision: 'DENY',
        reason,
      });
    }
    const reference = (req as Request & { correlationId?: string }).correlationId;
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Access denied' },
      reference,
    });
  }

  router.post(
    "/",
    requireRole('traveler'),
    validateCreate,
    async (req: Request, res: Response): Promise<void> => {
      const actor = (req as Request & { actor?: { sub: string } }).actor;
      const headers = req.validated?.headers as { "idempotency-key": string };
      const result = await domain.create(
        headers["idempotency-key"],
        req.validated?.body,
        actor?.sub ?? '',
      );
      res.status(201).json({ data: result });
    },
  );

  router.get(
    "/:bookingId",
    requireRole('traveler', 'support_agent'),
    validateBookingId,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const actorId = actor?.sub ?? '';
      const actorRole = actor?.roles[0] ?? 'traveler';

      try {
        const booking = await domain.getById(bookingId, actorId, actorRole);
        res.json({ data: booking });
      } catch (err) {
        if (err instanceof OwnershipError) {
          await denyWithAudit(res, req, 'booking', bookingId, 'READ', 'OWNERSHIP_PREDICATE_FAILED');
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    "/:bookingId/cancel",
    requireRole('traveler', 'support_agent'),
    validateBookingId,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const actorId = actor?.sub ?? '';
      const actorRole = actor?.roles[0] ?? 'traveler';

      try {
        const result = await domain.cancel(bookingId, actorId, actorRole);
        res.json({ data: result });
      } catch (err) {
        if (err instanceof OwnershipError) {
          await denyWithAudit(res, req, 'booking', bookingId, 'CANCEL', 'OWNERSHIP_PREDICATE_FAILED');
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
