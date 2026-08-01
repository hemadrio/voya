/**
 * Booking service routes — create, read, cancel, history.
 *
 * Authorization:
 *   - All routes require an authenticated actor (requireRole guard).
 *   - traveler: create, read own bookings, cancel own bookings, read own history.
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
 *
 * WO-101 additions:
 *   - GET /:bookingId/history — returns the redacted audit trail for a booking.
 *     Gated by ownership (traveler) or support_agent role; identity-doc fields
 *     are never exposed in the changeSummary.
 */
import { Router } from "express";
import { z } from "zod";
import { CreateBookingRequestSchema, identifier, AcceptPriceRequestSchema, PatchBookingRequestSchema } from "@travel/contracts";
import { requireRole, registerRouteGuard } from "@travel/auth";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";
import type { SecurityEventWriter } from "../domain/SecurityEventWriter.js";
import type { BookingRepository } from "../repositories/BookingRepository.js";
import { OwnershipError } from "../repositories/BookingRepository.js";
import type { PriceRevalidationService } from "../domain/PriceRevalidationService.js";
import { BookingEntitlementService } from "../domain/BookingEntitlementService.js";
import { requireOwnership } from "../middleware/requireOwnership.js";

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

// ---------------------------------------------------------------------------
// AuditLogRepository — injectable interface for reading audit history
// ---------------------------------------------------------------------------

/** One audit history item as returned by the /history endpoint. */
export interface AuditHistoryItem {
  id: string;
  action: string;
  actorRole: string;
  occurredAt: string;
  correlationId?: string;
  /** Redacted change summary — no identity-doc fields (passportNumber, dateOfBirth, etc.). */
  changeSummary?: Record<string, unknown>;
}

/** Injectable reader for booking_audit_log history queries. */
export interface AuditLogRepository {
  /**
   * Return audit entries for the given booking, ordered oldest-first.
   * Must never return rows containing credential material or identity-document fields.
   */
  getHistory(bookingId: string): Promise<AuditHistoryItem[]>;
}

export interface BookingDomain {
  create(idempotencyKey: string, body: unknown, userId: string): Promise<unknown>;
  getById(bookingId: string, actorId: string, actorRole: string): Promise<unknown>;
  cancel(bookingId: string, actorId: string, actorRole: string): Promise<unknown>;
  /** WO-044: modify contact fields; routes status change through lifecycle guard. */
  modify?(bookingId: string, patch: import("@travel/contracts").PatchBookingRequest, actorId: string, actorRole: string): Promise<unknown>;
}

// Compiled once at module scope for accept-price body.
const validateAcceptPrice = validateRequest({ body: AcceptPriceRequestSchema });

// WO-044: PATCH body validator
const validatePatch = validateRequest({ body: PatchBookingRequestSchema });

// Shared entitlement service instance (pure — no deps)
const entitlementService = new BookingEntitlementService();

// Register route guards in the global registry (for startup assertion + tests)
registerRouteGuard('POST', '/', 'requireRole', ['traveler']);
registerRouteGuard('GET', '/:bookingId', 'requireRole', ['traveler', 'support_agent']);
registerRouteGuard('PATCH', '/:bookingId', 'requireRole', ['traveler']);
registerRouteGuard('POST', '/:bookingId/cancel', 'requireRole', ['traveler', 'support_agent']);
registerRouteGuard('GET', '/:bookingId/history', 'requireRole', ['traveler', 'support_agent']);
registerRouteGuard('POST', '/:bookingId/revalidate', 'requireRole', ['traveler']);
registerRouteGuard('POST', '/:bookingId/accept-price', 'requireRole', ['traveler']);
registerRouteGuard('GET', '/:bookingId/saga', 'requireRole', ['traveler', 'support_agent']);

// ---------------------------------------------------------------------------
// SagaViewPort — injectable for GET /:bookingId/saga
// ---------------------------------------------------------------------------

export interface SagaViewPort {
  getView(bookingId: string): Promise<{
    sagaId: string;
    bookingId: string;
    status: string;
    legs: Array<{
      legId: string;
      offerId: string;
      supplier: string;
      travelCategory: string;
      status: string;
      supplierReference: string | null;
      lastError: string | null;
      attemptCount: number;
    }>;
  } | null>;
}

export function createBookingRouter(
  domain: BookingDomain,
  securityEventWriter?: SecurityEventWriter,
  bookingRepo?: BookingRepository,
  auditLogRepo?: AuditLogRepository,
  priceRevalidationService?: PriceRevalidationService,
  sagaViewPort?: SagaViewPort,
): Router {
  const router = Router();

  // Build the requireOwnership middleware once, sharing the entitlement service.
  // bookingRepo satisfies OwnershipBookingPort via findBookingOwner().
  const ownershipPort = bookingRepo
    ? { findBookingById: (id: string) => bookingRepo.findBookingOwner(id) }
    : null;

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

  // ── PATCH /:bookingId ──────────────────────────────────────────────────
  // WO-044: Modify mutable contact fields (contactPhone, contactEmail).
  //
  // Ownership is enforced at two independent layers:
  //   1. requireOwnership middleware (second line of defence after requireRole).
  //   2. domain.modify() re-derives entitlement from the DB principal;
  //      removing the middleware alone cannot expose data.
  //
  // support_agent is intentionally EXCLUDED (requireRole: traveler only);
  // a support_agent hitting this endpoint receives 403 from requireRole before
  // ownership or domain logic is ever consulted.

  // Register optional ownership middleware only when bookingRepo is wired.
  const patchMiddleware = ownershipPort
    ? requireOwnership('MODIFY', ownershipPort, entitlementService, securityEventWriter)
    : null;

  router.patch(
    "/:bookingId",
    requireRole('traveler'),
    validateBookingId,
    validatePatch,
    async (req: Request, res: Response, next: import("express").NextFunction): Promise<void> => {
      if (patchMiddleware) {
        return patchMiddleware(req, res, next);
      }
      next();
    },
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const patch = req.validated?.body as import("@travel/contracts").PatchBookingRequest;
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const actorId = actor?.sub ?? '';
      const actorRole = actor?.roles[0] ?? 'traveler';
      const reference = (req as Request & { correlationId?: string }).correlationId;

      if (!domain.modify) {
        res.status(501).json({
          error: { code: 'NOT_IMPLEMENTED', message: 'Booking modification not configured' },
          reference,
        });
        return;
      }

      const result = await domain.modify(bookingId, patch, actorId, actorRole);
      res.json({ data: result });
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

  // ── GET /:bookingId/history ─────────────────────────────────────────────
  // WO-101: Returns the redacted audit trail for a booking.
  //   - traveler: must own the booking (ownership check via bookingRepo).
  //   - support_agent: may read any booking's history without ownership check.
  //   - Identity-document fields are never included in changeSummary (enforced
  //     at the AuditLogRepository layer and in PrismaAuditWriter redaction).
  //   - Returns 404 when the booking does not exist.
  //   - Returns 403 for a non-owner without the support_agent role.
  //   - Returns 501 when auditLogRepo is not wired (configuration error).
  router.get(
    "/:bookingId/history",
    requireRole('traveler', 'support_agent'),
    validateBookingId,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const actorId = actor?.sub ?? '';
      const actorRole = actor?.roles[0] ?? 'traveler';
      const reference = (req as Request & { correlationId?: string }).correlationId;

      if (!auditLogRepo) {
        res.status(501).json({
          error: { code: 'NOT_IMPLEMENTED', message: 'Audit log repository not configured' },
          reference,
        });
        return;
      }

      // Ownership gate for traveler role — support_agent bypasses this.
      if (actorRole === 'traveler' && bookingRepo) {
        try {
          await bookingRepo.findOwnedBookingOrThrow(bookingId, actorId);
        } catch (err) {
          if (err instanceof OwnershipError) {
            await denyWithAudit(
              res, req, 'booking', bookingId, 'READ_HISTORY', 'OWNERSHIP_PREDICATE_FAILED',
            );
            return;
          }
          throw err;
        }
      } else if (actorRole === 'traveler' && !bookingRepo) {
        // bookingRepo not wired — cannot enforce ownership, deny by default
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Access denied' },
          reference,
        });
        return;
      }

      const items = await auditLogRepo.getHistory(bookingId);
      res.json({ items });
    },
  );

  // ── POST /:bookingId/revalidate ─────────────────────────────────────────
  // WO-042: Re-price every leg through the supplier adapter port within
  // 1,500 ms.  On price change the booking is NOT payable until accept-price.
  router.post(
    "/:bookingId/revalidate",
    requireRole('traveler'),
    validateBookingId,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const correlationId = (req as Request & { correlationId?: string }).correlationId;
      const reference = correlationId;

      if (!priceRevalidationService) {
        res.status(501).json({
          error: { code: 'NOT_IMPLEMENTED', message: 'Price revalidation not configured' },
          reference,
        });
        return;
      }

      // Ownership check — traveler must own the booking.
      if (bookingRepo) {
        try {
          await bookingRepo.findOwnedBookingOrThrow(bookingId, actor?.sub ?? '');
        } catch (err) {
          if (err instanceof OwnershipError) {
            await denyWithAudit(res, req, 'booking', bookingId, 'REVALIDATE', 'OWNERSHIP_PREDICATE_FAILED');
            return;
          }
          throw err;
        }
      }

      const result = await priceRevalidationService.revalidate(
        bookingId,
        { id: actor?.sub ?? '', role: actor?.roles[0] ?? 'traveler' },
        correlationId,
      );

      res.json({
        data: {
          bookingId: result.bookingId,
          priceChanged: result.priceChanged,
          previousTotal: result.previousTotal,
          newTotal: result.newTotal,
          currency: result.currency,
          delta: result.delta,
          quoteExpiresAt: result.quoteExpiresAt.toISOString(),
          legs: result.legs,
        },
        reference,
      });
    },
  );

  // ── POST /:bookingId/accept-price ───────────────────────────────────────
  // WO-042: Record traveler consent to a changed price.  Blocks payment until
  // the exact newTotal from the revalidate response is submitted here.
  router.post(
    "/:bookingId/accept-price",
    requireRole('traveler'),
    validateBookingId,
    validateAcceptPrice,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const body = req.validated?.body as { acceptedTotal: number; currency: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const correlationId = (req as Request & { correlationId?: string }).correlationId;
      const reference = correlationId;

      if (!priceRevalidationService) {
        res.status(501).json({
          error: { code: 'NOT_IMPLEMENTED', message: 'Price revalidation not configured' },
          reference,
        });
        return;
      }

      // Ownership check.
      if (bookingRepo) {
        try {
          await bookingRepo.findOwnedBookingOrThrow(bookingId, actor?.sub ?? '');
        } catch (err) {
          if (err instanceof OwnershipError) {
            await denyWithAudit(res, req, 'booking', bookingId, 'ACCEPT_PRICE', 'OWNERSHIP_PREDICATE_FAILED');
            return;
          }
          throw err;
        }
      }

      const result = await priceRevalidationService.acceptPrice(
        bookingId,
        body.acceptedTotal,
        body.currency,
        { id: actor?.sub ?? '', role: actor?.roles[0] ?? 'traveler' },
        correlationId,
      );

      res.json({
        data: { payableUntil: result.payableUntil.toISOString() },
        reference,
      });
    },
  );

  // ── GET /:bookingId/saga — return saga status for owner or support_agent ──
  //
  // Returns the saga state including per-leg status, supplier, category, and
  // the last error for any failed leg.  The failing leg is identified by name
  // for the traveler (AC5).
  router.get(
    "/:bookingId/saga",
    requireRole('traveler', 'support_agent'),
    validateBookingId,
    async (req: Request, res: Response): Promise<void> => {
      const { bookingId } = req.validated?.params as { bookingId: string };
      const reference = (req as Request & { correlationId?: string }).correlationId;
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;

      if (!sagaViewPort) {
        res.status(501).json({
          error: { code: 'NOT_IMPLEMENTED', message: 'Saga view is not configured' },
          reference,
        });
        return;
      }

      // Ownership check: traveler may only read their own saga; support_agent reads any.
      const roles = actor?.roles ?? [];
      const isTravelerOnly = roles.includes('traveler') && !roles.includes('support_agent');
      if (isTravelerOnly && bookingRepo) {
        const owner = await bookingRepo.findBookingOwner(bookingId);
        if (!owner) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Booking not found' }, reference });
          return;
        }
        if (owner.userId !== actor?.sub) {
          await denyWithAudit(res, req, 'checkout_saga', bookingId, 'READ_SAGA', 'OWNERSHIP_PREDICATE_FAILED');
          return;
        }
      }

      const view = await sagaViewPort.getView(bookingId);
      if (!view) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No active saga for this booking' }, reference });
        return;
      }

      res.json({ data: view, reference });
    },
  );

  return router;
}
