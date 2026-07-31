/**
 * Car search routes.
 *
 * POST /v1/cars/search — guest-accessible, validated against
 * CarRentalSearchRequestSchema (including pickup-window refinements) before any
 * domain work occurs. Pickup-window coherence (dropoff strictly after pickup,
 * future pickup) is enforced in the schema so zero supplier calls are made on
 * rejection.
 */

import { Router } from 'express';
import { CarRentalSearchRequestSchema } from '@travel/contracts';
import { validateRequest } from '../../../../shared/middleware/validateRequest.js';
import type { ICarSearchService } from '../domain/CarSearchService.js';
import { createCarSearchController } from '../controllers/CarSearchController.js';

const validateCarSearch = validateRequest({ body: CarRentalSearchRequestSchema });

export interface CarSearchRouterOptions {
  carSearchService: ICarSearchService;
}

export function createCarSearchRouter(options: CarSearchRouterOptions): Router {
  const router = Router();
  const handler = createCarSearchController({ carSearchService: options.carSearchService });
  router.post('/search', validateCarSearch, handler);
  return router;
}
