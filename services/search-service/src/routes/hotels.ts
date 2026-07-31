/**
 * Hotel search routes.
 *
 * POST /search/hotels — validates against HotelSearchRequestSchema (US-002).
 * Check-out on or before check-in is rejected at the boundary before any
 * supplier call is made.
 */
import { Router } from "express";
import { HotelSearchRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { SearchAdapter } from "../adapters/SearchAdapter.js";
import type { HotelSearchRequest } from "@travel/contracts";
import type { Request, Response } from "express";

const hotelBodyValidator = validateRequest({ body: HotelSearchRequestSchema });

export function createHotelRouter(adapter: SearchAdapter): Router {
  const router = Router();

  router.post(
    "/",
    hotelBodyValidator,
    async (req: Request, res: Response): Promise<void> => {
      const body = (req as Request & { validated?: { body?: HotelSearchRequest } }).validated?.body!;
      const offers = await adapter.searchHotels(body);
      res.json({ data: offers });
    },
  );

  return router;
}
