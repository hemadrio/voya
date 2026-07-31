/**
 * Hotel search routes.
 *
 * POST /v1/hotels/search — guest-accessible, validated against
 * HotelSearchRequestSchema (including date coherence refinement) before any
 * domain work occurs. Date coherence (checkOut > checkIn) is enforced in the
 * schema so zero supplier calls are made on rejection.
 */

import { Router } from 'express';
import { HotelSearchRequestSchema } from '@travel/contracts';
import { validateRequest } from '../../../../shared/middleware/validateRequest.js';
import type { IHotelSearchService } from '../domain/HotelSearchService.js';
import { createHotelSearchController } from '../controllers/HotelSearchController.js';

const validateHotelSearch = validateRequest({ body: HotelSearchRequestSchema });

export interface HotelSearchRouterOptions {
  hotelSearchService: IHotelSearchService;
}

export function createHotelSearchRouter(options: HotelSearchRouterOptions): Router {
  const router = Router();
  const handler = createHotelSearchController({ hotelSearchService: options.hotelSearchService });
  router.post('/search', validateHotelSearch, handler);
  return router;
}
