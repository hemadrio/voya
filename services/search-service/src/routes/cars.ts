/**
 * Car rental search routes.
 *
 * POST /search/cars — validates against CarRentalSearchRequestSchema (US-003).
 * Drop-off before pickup is rejected at the boundary before any supplier
 * call is made.
 */
import { Router } from "express";
import { CarRentalSearchRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { SearchAdapter } from "../adapters/SearchAdapter.js";
import type { CarRentalSearchRequest } from "@travel/contracts";
import type { Request, Response } from "express";

const carBodyValidator = validateRequest({ body: CarRentalSearchRequestSchema });

export function createCarRouter(adapter: SearchAdapter): Router {
  const router = Router();

  router.post(
    "/",
    carBodyValidator,
    async (req: Request, res: Response): Promise<void> => {
      const body = (req as Request & { validated?: { body?: CarRentalSearchRequest } }).validated?.body!;
      const offers = await adapter.searchCars(body);
      res.json({ data: offers });
    },
  );

  return router;
}
