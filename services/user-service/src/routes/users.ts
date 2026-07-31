/**
 * User service routes — profile read, preferences update.
 *
 * Authorization:
 *   - GET /:userId/profile — traveler (own profile) or support_agent (any profile).
 *     support_agent projection NEVER includes identity-document columns (BR-10).
 *   - PUT /:userId/preferences — traveler only (own preferences).
 *
 * Ownership:
 *   - Traveler profile/preferences access is guarded by the domain layer
 *     which re-derives ownership from the database, not from the token.
 *
 * Route params are validated with an identifier schema so a non-UUID userId
 * is rejected at the boundary before any ownership lookup or database call.
 */
import { Router } from "express";
import { z } from "zod";
import { TravelPreferencesSchema, identifier } from "@travel/contracts";
import { requireRole, registerRouteGuard } from "@travel/auth";
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
  getProfile(userId: string, actorId: string, actorRole: string): Promise<unknown>;
  updatePreferences(userId: string, prefs: unknown, actorId: string): Promise<unknown>;
}

// Register route guards in the global registry (for startup assertion + tests)
registerRouteGuard('GET', '/:userId/profile', 'requireRole', ['traveler', 'support_agent']);
registerRouteGuard('PUT', '/:userId/preferences', 'requireRole', ['traveler']);

export function createUserRouter(domain: UserDomain): Router {
  const router = Router();

  router.get(
    "/:userId/profile",
    requireRole('traveler', 'support_agent'),
    validateUserId,
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = req.validated?.params as { userId: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;
      const actorId = actor?.sub ?? '';
      const actorRole = actor?.roles[0] ?? 'traveler';
      const profile = await domain.getProfile(userId, actorId, actorRole);
      res.json({ data: profile });
    },
  );

  router.put(
    "/:userId/preferences",
    requireRole('traveler'),
    validatePreferences,
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = req.validated?.params as { userId: string };
      const actor = (req as Request & { actor?: { sub: string } }).actor;
      const actorId = actor?.sub ?? '';
      const result = await domain.updatePreferences(userId, req.validated?.body, actorId);
      res.json({ data: result });
    },
  );

  return router;
}
