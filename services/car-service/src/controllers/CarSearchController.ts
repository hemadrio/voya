/**
 * CarSearchController — thin HTTP adapter for the car rental search domain service.
 *
 * Responsibilities (and only these):
 *  1. Extract the validated request body (already parsed by validateRequest middleware).
 *  2. Resolve the trace/correlation ID for the error envelope reference field.
 *  3. Invoke one domain service method.
 *  4. Map the domain result to the HTTP response shape.
 *  5. Map domain/supplier errors to the correct HTTP status and shared envelope.
 *
 * Car wire shape: vehicleClass (including UNKNOWN), totalPrice, currency,
 * pickupLocationId, dropoffLocationId, supplier, provenance, bookable, expiresAt.
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
import type { CarRentalSearchRequest } from '@travel/contracts';
import type { ICarSearchService, SupplierOutcomeEntry } from '../domain/CarSearchService.js';
import type { RankedOffer } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Wire offer shape
// ---------------------------------------------------------------------------

interface WireCarOffer {
  id: string;
  vehicleClass: string;
  totalPrice: number;
  currency: string;
  pickupLocationId: string;
  dropoffLocationId: string;
  supplier: string;
  provenance: string;
  bookable: boolean;
  expiresAt: string;
}

function toWireOffer(ranked: RankedOffer): WireCarOffer {
  const o = ranked.offer;
  const details = o.details as Record<string, unknown>;

  return {
    id: o.id,
    vehicleClass: typeof details['vehicleClass'] === 'string' ? details['vehicleClass'] : 'UNKNOWN',
    totalPrice: typeof details['totalPrice'] === 'number' ? details['totalPrice'] : o.price,
    currency: o.currency,
    pickupLocationId: typeof details['pickupLocation'] === 'string' ? details['pickupLocation'] : '',
    dropoffLocationId: typeof details['dropoffLocation'] === 'string' ? details['dropoffLocation'] : '',
    supplier: (details['supplier'] as string | undefined) ?? o.provenance,
    provenance: o.provenance,
    bookable: o.bookable,
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

export function createCarSearchController(deps: { carSearchService: ICarSearchService }) {
  const { carSearchService } = deps;

  return async function carSearchHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = (req as Request & { validated?: { body?: CarRentalSearchRequest } })
        .validated?.body as CarRentalSearchRequest;

      const correlationId: string =
        (req as Request & { correlationId?: string }).correlationId ??
        (req.headers['x-trace-id'] as string | undefined) ??
        'unknown';

      const result = await carSearchService.search(body, correlationId);

      const responseBody: Record<string, unknown> = {
        offers: result.offers.map(toWireOffer),
        supplierOutcomes: result.supplierOutcomes.map(toWireOutcome),
        freshness: {
          generatedAt: result.freshness.generatedAt.toISOString(),
          stale: result.freshness.stale,
        },
        cacheAvailable: result.cacheAvailable,
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
          supplierRejected('The supplier rejected the car rental search request.'),
          correlationId,
        );
        res.status(status).json(envelope);
        return;
      }

      next(err);
    }
  };
}
