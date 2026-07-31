/**
 * Flight search routes.
 *
 * POST /search/flights — validates against FlightSearchRequestSchema (BR-11,
 * US-001) then calls the injected adapter.  A four-letter airport code is
 * rejected with 400 before any supplier call is made.
 *
 * Schemas are resolved at module import (factory call), not per request.
 */
import { Router } from "express";
import { FlightSearchRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { SearchAdapter } from "../adapters/SearchAdapter.js";
import type { FlightSearchRequest } from "@travel/contracts";
import type { Request, Response } from "express";

// Compiled once at module scope — parse cost is bounded to parse time only.
const flightBodyValidator = validateRequest({ body: FlightSearchRequestSchema });

export function createFlightRouter(adapter: SearchAdapter): Router {
  const router = Router();

  router.post(
    "/",
    flightBodyValidator,
    async (req: Request, res: Response): Promise<void> => {
      const body = (req as Request & { validated?: { body?: FlightSearchRequest } }).validated?.body!;
      const offers = await adapter.searchFlights(body);
      res.json({ data: offers });
    },
  );

  return router;
}
