/**
 * Itinerary document routes — /v1/itineraries/:itineraryId/documents (WO-054).
 *
 * Routes:
 *   POST   /:itineraryId/documents            — generate trip document PDF
 *   GET    /:itineraryId/documents/:documentId — get document status + fresh URL
 *
 * Authorization: traveler role required on all routes.
 * Rate limiting: per-endpoint limiter (2 generations per itinerary per 10 min).
 * Validation: Zod schemas from @travel/contracts/documents.
 *
 * Security:
 *   - signed download URLs are NEVER logged (redacted from all log fields)
 *   - stack traces are never returned to callers
 *   - DocumentGenerationError surfaces a retry affordance with documentId
 */

import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { requireRole, registerRouteGuard } from "@travel/auth";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import { PostDocumentRequestSchema, SendDocumentRequestSchema } from "@travel/contracts/documents";
import type { TripDocumentService } from "../domain/TripDocumentService.js";
import { DocumentGenerationError } from "../domain/TripDocumentService.js";
import type { TripDocumentDeliveryService } from "../domain/TripDocumentDeliveryService.js";

// Compiled once at module scope (not per-request).
const ItineraryIdParamsSchema = z.object({
  itineraryId: z.string().uuid("itineraryId must be a UUID"),
});
const DocumentIdParamsSchema = z.object({
  itineraryId: z.string().uuid("itineraryId must be a UUID"),
  documentId: z.string().uuid("documentId must be a UUID"),
});

const validateItineraryId = validateRequest({ params: ItineraryIdParamsSchema });
const validateDocumentId = validateRequest({ params: DocumentIdParamsSchema });
const validatePostBody = validateRequest({ body: PostDocumentRequestSchema });
const validateSendBody = validateRequest({ body: SendDocumentRequestSchema });

// Route guards for startup assertion registry.
registerRouteGuard("POST", "/:itineraryId/documents", "requireRole", ["traveler"]);
registerRouteGuard("POST", "/:itineraryId/documents/send", "requireRole", ["traveler"]);
registerRouteGuard("GET", "/:itineraryId/documents/:documentId", "requireRole", ["traveler"]);

type ActorReq = Request & { actor?: { sub: string; roles: string[] }; correlationId?: string };

export function createItineraryDocumentRouter(
  documentService?: TripDocumentService,
  deliveryService?: TripDocumentDeliveryService,
  sendRateLimiter?: RequestHandler,
): Router {
  const router = Router({ mergeParams: true });

  function notWired(res: Response, req: Request): void {
    const ref = (req as ActorReq).correlationId;
    res.status(501).json({
      error: { code: "NOT_IMPLEMENTED", message: "Document service not configured" },
      reference: ref,
    });
  }

  // ── POST /:itineraryId/documents — generate a trip document ─────────────
  router.post(
    "/:itineraryId/documents",
    requireRole("traveler"),
    validateItineraryId,
    validatePostBody,
    async (req: Request, res: Response): Promise<void> => {
      if (!documentService) { notWired(res, req); return; }

      const typedReq = req as ActorReq;
      const { itineraryId } = req.validated?.params as { itineraryId: string };
      const body = req.validated?.body as import("@travel/contracts/documents").PostDocumentRequest;
      const reference = typedReq.correlationId;
      const actor = typedReq.actor;

      try {
        const result = await documentService.generateDocument(
          itineraryId,
          actor?.sub ?? "",
          { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
          reference ?? "no-correlation-id",
          body.locale,
        );

        // 201 — document generated synchronously (READY immediately)
        res.status(201).json({ data: result, reference });
      } catch (err) {
        if (err instanceof DocumentGenerationError) {
          res.status(500).json({
            error: {
              code: "DOCUMENT_GENERATION_FAILED",
              message: "Document generation failed. Please retry.",
              retry: true,
              documentId: err.documentId,
            },
            reference,
          });
          return;
        }
        throw err;
      }
    },
  );

  // ── POST /:itineraryId/documents/send — queue async document email ──────
  // Registered BEFORE /:documentId to prevent "send" being captured as a param.
  router.post(
    "/:itineraryId/documents/send",
    requireRole("traveler"),
    validateItineraryId,
    validateSendBody,
    ...(sendRateLimiter ? [sendRateLimiter] : []),
    async (req: Request, res: Response): Promise<void> => {
      if (!deliveryService) { notWired(res, req); return; }

      const typedReq = req as ActorReq;
      const { itineraryId } = req.validated?.params as { itineraryId: string };
      const body = req.validated?.body as import("@travel/contracts/documents").SendDocumentRequest;
      const reference = typedReq.correlationId;
      const actor = typedReq.actor;

      const result = await deliveryService.requestDocumentSend(
        itineraryId,
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
        reference ?? "no-correlation-id",
        body.locale,
      );

      res.status(202).json({ data: result, reference });
    },
  );

  // ── GET /:itineraryId/documents/:documentId — get status + fresh URL ────
  router.get(
    "/:itineraryId/documents/:documentId",
    requireRole("traveler"),
    validateDocumentId,
    async (req: Request, res: Response): Promise<void> => {
      if (!documentService) { notWired(res, req); return; }

      const typedReq = req as ActorReq;
      const { itineraryId, documentId } = req.validated?.params as {
        itineraryId: string;
        documentId: string;
      };
      const reference = typedReq.correlationId;
      const actor = typedReq.actor;

      const result = await documentService.getDocument(
        itineraryId,
        documentId,
        actor?.sub ?? "",
        { id: actor?.sub ?? "", role: actor?.roles[0] ?? "traveler" },
        reference ?? "no-correlation-id",
      );

      res.json({ data: result, reference });
    },
  );

  return router;
}
