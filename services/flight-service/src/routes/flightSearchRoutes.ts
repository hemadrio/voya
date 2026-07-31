/**
 * Flight search routes.
 *
 * POST /v1/flights/search — guest-accessible, validated against
 * FlightSearchRequestSchema before any domain work occurs.
 *
 * Route responsibilities (thin by design):
 *  - Apply Zod validation middleware; validation failures return 400 with the
 *    standard error envelope including the offending field name.
 *  - Delegate to FlightSearchController for all domain logic.
 *
 * The route is added to the API gateway guest allow-list so unauthenticated
 * callers can reach it.  Authenticated callers additionally receive
 * preference-influenced ranking (the controller passes preferences when an
 * actor context is present on the request).
 */

import { Router } from 'express';
import { FlightSearchRequestSchema } from '@travel/contracts';
import { validateRequest } from '../../../../shared/middleware/validateRequest.js';
import type { IFlightSearchService } from '../domain/FlightSearchService.js';
import { createFlightSearchController } from '../controllers/FlightSearchController.js';

// Compile validator once at module scope — not per request.
const validateFlightSearch = validateRequest({ body: FlightSearchRequestSchema });

export interface FlightSearchRouterOptions {
  flightSearchService: IFlightSearchService;
}

export function createFlightSearchRouter(options: FlightSearchRouterOptions): Router {
  const router = Router();
  const handler = createFlightSearchController({
    flightSearchService: options.flightSearchService,
  });

  // POST /v1/flights/search (prefix "/v1/flights" comes from app.ts mount)
  router.post('/search', validateFlightSearch, handler);

  return router;
}
