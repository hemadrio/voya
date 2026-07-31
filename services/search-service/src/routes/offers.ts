/**
 * Offer resolution routes.
 *
 * GET /v1/offers/:id — resolves a cached offer by deterministic ID.
 * No authentication required (offer IDs are opaque hashes; no user data exposed).
 */

import { Router } from 'express';
import { createOfferController } from '../controllers/OfferController.js';
import type { IOfferResolutionService } from '../domain/OfferResolutionService.js';

export interface OfferRouterOptions {
  offerResolutionService: IOfferResolutionService;
}

export function createOfferRouter(options: OfferRouterOptions): Router {
  const router = Router();
  const handler = createOfferController({ offerResolutionService: options.offerResolutionService });
  router.get('/:id', handler);
  return router;
}
