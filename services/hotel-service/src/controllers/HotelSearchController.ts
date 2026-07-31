/**
 * HotelSearchController — thin HTTP adapter for the hotel search domain service.
 *
 * Responsibilities (and only these):
 *  1. Extract the validated request body (already parsed by validateRequest middleware).
 *  2. Resolve the trace/correlation ID for the error envelope reference field.
 *  3. Invoke one domain service method.
 *  4. Map the domain result to the HTTP response shape.
 *  5. Map domain/supplier errors to the correct HTTP status and shared envelope.
 *
 * Hotel wire shape includes nullable quality signals (starRating, reviewCount,
 * reviewScore) — absent means null, never a default value.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  serialiseError,
  supplierTimeout,
  supplierRejected,
} from '@travel/contracts';
import {
  SupplierRejectedRequestError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { HotelSearchRequest } from '@travel/contracts';
import type { IHotelSearchService, SupplierOutcomeEntry } from '../domain/HotelSearchService.js';
import type { RankedOffer } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Wire offer shape
// ---------------------------------------------------------------------------

interface WireHotelOffer {
  id: string;
  propertyName: string;
  supplier: string;
  provenance: string;
  bookable: boolean;
  nightlyPrice: number;
  totalPrice: number | null;
  currency: string;
  starRating: number | null;
  reviewCount: number | null;
  reviewScore: number | null;
  expiresAt: string;
}

function toWireOffer(ranked: RankedOffer): WireHotelOffer {
  const o = ranked.offer;
  const details = o.details as Record<string, unknown>;

  const totalPrice = typeof details['totalPrice'] === 'number' ? details['totalPrice'] : null;
  const reviewScore =
    typeof details['reviewScore'] === 'number' ? details['reviewScore'] : null;

  return {
    id: o.id,
    propertyName: o.title,
    supplier: (details['supplier'] as string | undefined) ?? o.provenance,
    provenance: o.provenance,
    bookable: o.bookable,
    nightlyPrice: o.price,
    totalPrice,
    currency: o.currency,
    starRating: typeof o.rating === 'number' ? o.rating : null,
    reviewCount: typeof o.reviews === 'number' ? o.reviews : null,
    reviewScore,
    expiresAt: o.expiresAt instanceof Date ? o.expiresAt.toISOString() : String(o.expiresAt),
  };
}

function toWireOutcome(entry: SupplierOutcomeEntry): { supplier: string; outcome: string } {
  return {
    supplier: entry.supplier,
    outcome:
      entry.outcome === 'SUCCEEDED'
        ? 'available'
        : entry.outcome === 'TIMED_OUT'
          ? 'timed out'
          : entry.outcome === 'SKIPPED_CIRCUIT_OPEN'
            ? 'temporarily unavailable'
            : 'unavailable',
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function createHotelSearchController(deps: { hotelSearchService: IHotelSearchService }) {
  const { hotelSearchService } = deps;

  return async function hotelSearchHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req as Request & { validated?: { body?: HotelSearchRequest } })
        .validated?.body as HotelSearchRequest;

      const correlationId: string =
        (req as Request & { correlationId?: string }).correlationId ??
        (req.headers['x-trace-id'] as string | undefined) ??
        'unknown';

      const result = await hotelSearchService.search(body, correlationId);

      const responseBody: Record<string, unknown> = {
        offers: result.offers.map(toWireOffer),
        supplierOutcomes: result.supplierOutcomes.map(toWireOutcome),
        freshness: {
          generatedAt: result.freshness.generatedAt.toISOString(),
          stale: result.freshness.stale,
        },
      };

      if (result.emptyState !== undefined) {
        responseBody['emptyState'] = result.emptyState;
      }

      res.status(200).json(responseBody);
    } catch (err: unknown) {
      if (err instanceof SupplierTimeoutError) {
        const correlationId: string =
          (req as Request & { correlationId?: string }).correlationId ??
          (req.headers['x-trace-id'] as string | undefined) ??
          'unknown';
        const { envelope, status } = serialiseError(supplierTimeout(), correlationId);
        res.status(status).json(envelope);
        return;
      }

      if (err instanceof SupplierRejectedRequestError) {
        const correlationId: string =
          (req as Request & { correlationId?: string }).correlationId ??
          (req.headers['x-trace-id'] as string | undefined) ??
          'unknown';
        const { envelope, status } = serialiseError(
          supplierRejected('The supplier rejected the hotel search request.'),
          correlationId,
        );
        res.status(status).json(envelope);
        return;
      }

      next(err);
    }
  };
}
