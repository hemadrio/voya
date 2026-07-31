/**
 * Booking service routes — create, read, cancel.
 *
 * Idempotency-key header is validated before CreateBookingRequest body so
 * the header presence is asserted at the schema boundary.
 *
 * Route params (bookingId) are validated as identifiers so non-valid IDs
 * fail with 400 before any ownership lookup or database access.
 */
import { Router } from "express";
import { z } from "zod";
import { CreateBookingRequestSchema, identifier } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";

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
  create(idempotencyKey: string, body: unknown): Promise<unknown>;
  getById(bookingId: string): Promise<unknown>;
  cancel(bookingId: string): Promise<unknown>;
}

export function createBookingRouter(domain: BookingDomain): Router {
  const router = Router();

  router.post("/", validateCreate, async (req: Request, res: Response): Promise<void> => {
    const headers = req.validated?.headers as { "idempotency-key": string };
    const result = await domain.create(headers["idempotency-key"], req.validated?.body);
    res.status(201).json({ data: result });
  });

  router.get("/:bookingId", validateBookingId, async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = req.validated?.params as { bookingId: string };
    const booking = await domain.getById(bookingId);
    res.json({ data: booking });
  });

  router.post("/:bookingId/cancel", validateBookingId, async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = req.validated?.params as { bookingId: string };
    const result = await domain.cancel(bookingId);
    res.json({ data: result });
  });

  return router;
}
