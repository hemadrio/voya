/**
 * Itinerary routes — CRUD for /v1/itineraries (WO-053).
 *
 * Authorization: all routes require the 'traveler' role; no support_agent or
 * system access to itinerary management.
 *
 * Ownership: ItineraryService enforces the 404-vs-403 distinction.
 * Every denied access writes an append-only SecurityEvent row.
 *
 * Validation: Zod schemas from @travel/contracts compiled at module scope.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  CreateItineraryRequestSchema,
  UpdateItineraryRequestSchema,
} from "@travel/contracts";
import { requireRole, registerRouteGuard } from "@travel/auth";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { ItineraryService } from "../domain/ItineraryService.js";

// Compiled once at module scope (not per-request).
const ItineraryIdParamsSchema = z.object({
  itineraryId: z.string().trim().min(1),
});

const validateCreate = validateRequest({ body: CreateItineraryRequestSchema });
const validateUpdate = validateRequest({ body: UpdateItineraryRequestSchema });
const validateId = validateRequest({ params: ItineraryIdParamsSchema });

// Register route guards for the startup assertion registry.
registerRouteGuard("POST", "/", "requireRole", ["traveler"]);
registerRouteGuard("GET", "/", "requireRole", ["traveler"]);
registerRouteGuard("GET", "/:itineraryId", "requireRole", ["traveler"]);
registerRouteGuard("PATCH", "/:itineraryId", "requireRole", ["traveler"]);
registerRouteGuard("DELETE", "/:itineraryId", "requireRole", ["traveler"]);

export function createItineraryRouter(
  itineraryService?: ItineraryService,
): Router {
  const router = Router();

  /** Return 501 when the service is not wired (configuration error). */
  function notWired(res: Response, req: Request): void {
    const reference = (req as Request & { correlationId?: string }).correlationId;
    res.status(501).json({
      error: { code: "NOT_IMPLEMENTED", message: "Itinerary service not configured" },
      reference,
    });
  }

  // ── POST / — create itinerary ──────────────────────────────────────────
  router.post(
    "/",
    requireRole("traveler"),
    validateCreate,
    async (req: Request, res: Response): Promise<void> => {
      if (!itineraryService) { notWired(res, req); return; }

      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const body = req.validated?.body as import("@travel/contracts").CreateItineraryRequest;
      const reference = (req as Request & { correlationId?: string }).correlationId;

      const result = await itineraryService.create(
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
        {
          name: body.name,
          description: body.description,
          startDate: body.startDate,
          endDate: body.endDate,
          bookingIds: body.bookingIds,
        },
      );

      res.status(201).json({ data: result, reference });
    },
  );

  // ── GET / — list itineraries for authenticated user ────────────────────
  router.get(
    "/",
    requireRole("traveler"),
    async (req: Request, res: Response): Promise<void> => {
      if (!itineraryService) { notWired(res, req); return; }

      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const reference = (req as Request & { correlationId?: string }).correlationId;

      const result = await itineraryService.listByUser(
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
      );

      res.json({ data: result, reference });
    },
  );

  // ── GET /:itineraryId — read one itinerary ─────────────────────────────
  router.get(
    "/:itineraryId",
    requireRole("traveler"),
    validateId,
    async (req: Request, res: Response): Promise<void> => {
      if (!itineraryService) { notWired(res, req); return; }

      const { itineraryId } = req.validated?.params as { itineraryId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const reference = (req as Request & { correlationId?: string }).correlationId;

      const result = await itineraryService.getById(
        itineraryId,
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
      );

      res.json({ data: result, reference });
    },
  );

  // ── PATCH /:itineraryId — update itinerary ─────────────────────────────
  router.patch(
    "/:itineraryId",
    requireRole("traveler"),
    validateId,
    validateUpdate,
    async (req: Request, res: Response): Promise<void> => {
      if (!itineraryService) { notWired(res, req); return; }

      const { itineraryId } = req.validated?.params as { itineraryId: string };
      const body = req.validated?.body as import("@travel/contracts").UpdateItineraryRequest;
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const reference = (req as Request & { correlationId?: string }).correlationId;

      const result = await itineraryService.update(
        itineraryId,
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
        {
          name: body.name,
          description: body.description,
          startDate: body.startDate,
          endDate: body.endDate,
          addBookingIds: body.addBookingIds,
          removeBookingIds: body.removeBookingIds,
        },
      );

      res.json({ data: result, reference });
    },
  );

  // ── DELETE /:itineraryId — delete itinerary (detach, don't delete bookings)
  router.delete(
    "/:itineraryId",
    requireRole("traveler"),
    validateId,
    async (req: Request, res: Response): Promise<void> => {
      if (!itineraryService) { notWired(res, req); return; }

      const { itineraryId } = req.validated?.params as { itineraryId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;

      await itineraryService.delete(
        itineraryId,
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
      );

      res.status(204).send();
    },
  );

  return router;
}
