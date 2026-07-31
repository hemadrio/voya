/**
 * User service routes — profile read, preferences update.
 *
 * Route params are validated with an identifier schema so a non-UUID userId
 * is rejected at the boundary before any ownership lookup or database call.
 */
import { Router } from "express";
import { z } from "zod";
import { TravelPreferencesSchema, identifier } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";

// Compiled once at module scope.
const UserIdParamsSchema = z.object({ userId: identifier });
const validateUserId = validateRequest({ params: UserIdParamsSchema });
const validatePreferences = validateRequest({
  params: UserIdParamsSchema,
  body: TravelPreferencesSchema,
});

export interface UserDomain {
  getProfile(userId: string): Promise<unknown>;
  updatePreferences(userId: string, prefs: unknown): Promise<unknown>;
}

export function createUserRouter(domain: UserDomain): Router {
  const router = Router();

  router.get("/:userId/profile", validateUserId, async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.validated?.params as { userId: string };
    const profile = await domain.getProfile(userId);
    res.json({ data: profile });
  });

  router.put("/:userId/preferences", validatePreferences, async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.validated?.params as { userId: string };
    const result = await domain.updatePreferences(userId, req.validated?.body);
    res.json({ data: result });
  });

  return router;
}
