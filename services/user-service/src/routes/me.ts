/**
 * /v1/me routes — GDPR data-subject rights (BR-16).
 *
 * All routes derive the subject identity exclusively from the verified bearer
 * token (req.actor.sub). No client-supplied user identifier is accepted — this
 * is the deny-by-default posture required by BR-09.
 *
 * Routes:
 *   GET    /v1/me                 — profile read
 *   PATCH  /v1/me                 — profile rectification
 *   POST   /v1/me/export          — initiate async export
 *   GET    /v1/me/export/:id      — poll export status
 *   DELETE /v1/me                 — erasure request
 */
import { Router } from "express";
import { z } from "zod";
import { requireRole, registerRouteGuard } from "@travel/auth";
import {
  ProfilePatchSchema,
  ErasureRequestSchema,
} from "@travel/contracts/privacy";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response, NextFunction } from "express";
import type { DataSubjectRightsService } from "../services/DataSubjectRightsService.js";

// ---------------------------------------------------------------------------
// Compiled validation schemas
// ---------------------------------------------------------------------------

const validateProfilePatch = validateRequest({ body: ProfilePatchSchema });
const validateErasureRequest = validateRequest({ body: ErasureRequestSchema });
const ExportRequestIdParamsSchema = z.object({ requestId: z.string().uuid() });
const validateExportParams = validateRequest({ params: ExportRequestIdParamsSchema });

// ---------------------------------------------------------------------------
// Route-guard registration (startup assertion + integration tests)
// ---------------------------------------------------------------------------

registerRouteGuard("GET", "/v1/me", "requireRole", ["traveler"]);
registerRouteGuard("PATCH", "/v1/me", "requireRole", ["traveler"]);
registerRouteGuard("POST", "/v1/me/export", "requireRole", ["traveler"]);
registerRouteGuard("GET", "/v1/me/export/:requestId", "requireRole", ["traveler"]);
registerRouteGuard("DELETE", "/v1/me", "requireRole", ["traveler"]);

// ---------------------------------------------------------------------------
// Actor extraction helper
// ---------------------------------------------------------------------------

interface ActorContext {
  sub: string;
  roles: string[];
}

function extractActor(req: Request): ActorContext {
  const actor = (req as Request & { actor?: ActorContext }).actor;
  if (!actor?.sub) {
    throw Object.assign(new Error("Actor context missing"), { code: "UNAUTHORIZED", httpStatus: 401 });
  }
  return actor;
}

function getCorrelationId(req: Request): string {
  return (req.headers["x-correlation-id"] as string | undefined) ?? crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Error mapping helper
// ---------------------------------------------------------------------------

function mapServiceError(err: unknown): { status: number; code: string; message: string } {
  if (err && typeof err === "object" && "httpStatus" in err) {
    const e = err as { httpStatus: number; code: string; message: string };
    return { status: e.httpStatus, code: e.code, message: e.message };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createMeRouter(svc: DataSubjectRightsService): Router {
  const router = Router();

  // ── GET /v1/me ────────────────────────────────────────────────────────────

  router.get(
    "/",
    requireRole("traveler"),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actor = extractActor(req);
        const profile = await svc.getMyProfile(actor.sub, getCorrelationId(req));
        res.json({ data: profile });
      } catch (err) {
        const { status, code, message } = mapServiceError(err);
        if (status >= 500) return next(err);
        res.status(status).json({ error: { code, message } });
      }
    },
  );

  // ── PATCH /v1/me ──────────────────────────────────────────────────────────

  router.patch(
    "/",
    requireRole("traveler"),
    validateProfilePatch,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actor = extractActor(req);
        const patch = req.validated?.body;
        const profile = await svc.patchMyProfile(actor.sub, patch, getCorrelationId(req));
        res.json({ data: profile });
      } catch (err) {
        const { status, code, message } = mapServiceError(err);
        if (status >= 500) return next(err);
        res.status(status).json({ error: { code, message } });
      }
    },
  );

  // ── POST /v1/me/export ────────────────────────────────────────────────────

  router.post(
    "/export",
    requireRole("traveler"),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actor = extractActor(req);
        const accepted = await svc.requestExport(actor.sub, getCorrelationId(req));
        res.status(202).json({ data: accepted });
      } catch (err) {
        const { status, code, message } = mapServiceError(err);
        if (status >= 500) return next(err);
        res.status(status).json({ error: { code, message } });
      }
    },
  );

  // ── GET /v1/me/export/:requestId ──────────────────────────────────────────

  router.get(
    "/export/:requestId",
    requireRole("traveler"),
    validateExportParams,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actor = extractActor(req);
        const { requestId } = req.validated?.params as { requestId: string };
        const status = await svc.getExportStatus(actor.sub, requestId, getCorrelationId(req));
        res.json({ data: status });
      } catch (err) {
        const { status: httpStatus, code, message } = mapServiceError(err);
        if (httpStatus >= 500) return next(err);
        res.status(httpStatus).json({ error: { code, message } });
      }
    },
  );

  // ── DELETE /v1/me ─────────────────────────────────────────────────────────

  router.delete(
    "/",
    requireRole("traveler"),
    validateErasureRequest,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const actor = extractActor(req);
        const accepted = await svc.requestErasure(actor.sub, getCorrelationId(req));
        res.status(202).json({ data: accepted });
      } catch (err) {
        const { status, code, message } = mapServiceError(err);
        if (status >= 500) return next(err);
        res.status(status).json({ error: { code, message } });
      }
    },
  );

  return router;
}
