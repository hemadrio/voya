/**
 * OfferController — HTTP adapter for GET /v1/offers/:id.
 *
 * Responsibilities:
 *  1. Validate the id path parameter (64 hex chars → 400 if malformed).
 *  2. Delegate to OfferResolutionService.
 *  3. Map outcomes to HTTP responses:
 *       FRESH / STALE → 200 with offer + freshness block
 *       NOT_FOUND     → 404 with NOT_FOUND envelope
 *       EXPIRED       → 410 with OFFER_EXPIRED envelope
 *  4. Attach the trace ID as the envelope reference on errors.
 *
 * This controller never re-queries suppliers.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  serialiseError,
  notFound,
  offerExpired,
  validationFailed,
} from '@travel/contracts';
import type { IOfferResolutionService } from '../domain/OfferResolutionService.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const OFFER_ID_PATTERN = /^[0-9a-f]{64}$/;

function isValidOfferId(id: string): boolean {
  return OFFER_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function createOfferController(deps: { offerResolutionService: IOfferResolutionService }) {
  const { offerResolutionService } = deps;

  return async function offerHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const id = req.params['id'] ?? '';
      const correlationId: string =
        (req as Request & { correlationId?: string }).correlationId ??
        (req.headers['x-trace-id'] as string | undefined) ??
        'unknown';

      if (!isValidOfferId(id)) {
        const { envelope, status } = serialiseError(
          validationFailed('Offer identifier must be a 64-character hex string.', 'id'),
          correlationId,
        );
        res.status(status).json(envelope);
        return;
      }

      const result = await offerResolutionService.resolve(id);

      if (result.outcome === 'NOT_FOUND') {
        const { envelope, status } = serialiseError(
          notFound('Offer not found.', 'id'),
          correlationId,
        );
        res.status(status).json(envelope);
        return;
      }

      if (result.outcome === 'EXPIRED') {
        const { envelope, status } = serialiseError(
          offerExpired(),
          correlationId,
        );
        res.status(status).json(envelope);
        return;
      }

      // FRESH or STALE — include the indicative label for stale
      const offer = result.offer!;
      const freshness = result.freshness!;

      const responseBody: Record<string, unknown> = {
        offer: {
          ...offer,
          // Ensure expiresAt is always a string on the wire
          expiresAt:
            offer['expiresAt'] instanceof Date
              ? (offer['expiresAt'] as Date).toISOString()
              : String(offer['expiresAt']),
          // Illustrative offers must surface bookable false
          bookable:
            offer['provenance'] === 'ILLUSTRATIVE' ? false : Boolean(offer['bookable']),
        },
        freshness: {
          generatedAt: freshness.generatedAt.toISOString(),
          stale: freshness.stale,
          expiresAt: freshness.expiresAt.toISOString(),
          requiresRevalidation: freshness.requiresRevalidation,
          ...(freshness.stale
            ? { indicativeLabel: 'Price and availability may have changed. Re-validate before checkout.' }
            : {}),
        },
      };

      res.status(200).json(responseBody);
    } catch (err: unknown) {
      next(err);
    }
  };
}
