/**
 * FlightSearchController — thin HTTP adapter for the flight search domain service.
 *
 * Responsibilities (and only these):
 *  1. Extract the validated request body (already parsed by validateRequest middleware).
 *  2. Resolve the trace/correlation ID for the error envelope reference field.
 *  3. Invoke one domain service method.
 *  4. Map the domain result to the HTTP response shape.
 *  5. Map domain/supplier errors to the correct HTTP status + shared envelope.
 *
 * Absolutely no business logic: no cache, no supplier calls, no ranking.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  serialiseError,
  supplierUnavailable,
  supplierTimeout,
  supplierRejected,
} from '@travel/contracts';
import {
  SupplierRejectedRequestError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { FlightSearchRequest } from '@travel/contracts';
import type { IFlightSearchService } from '../domain/FlightSearchService.js';
import type { RankedOffer } from '@travel/offer-normaliser';
import type { SupplierOutcomeEntry } from '../domain/FlightSearchService.js';

// ---------------------------------------------------------------------------
// Wire shape — the serialisable offer returned in the HTTP response
// ---------------------------------------------------------------------------

interface WireOffer {
  id: string;
  supplier: string;
  provenance: string;
  bookable: boolean;
  totalPrice: number;
  currency: string;
  cabinClass: unknown;
  expiresAt: string;
  details: Record<string, unknown>;
}

function toWireOffer(ranked: RankedOffer): WireOffer {
  const o = ranked.offer;
  const details = o.details as Record<string, unknown>;
  return {
    id: o.id,
    supplier: (details['supplier'] as string | undefined) ?? o.provenance,
    provenance: o.provenance,
    bookable: o.bookable,
    totalPrice: o.price,
    currency: o.currency,
    cabinClass: details['cabinClass'] ?? null,
    expiresAt: o.expiresAt instanceof Date
      ? o.expiresAt.toISOString()
      : String(o.expiresAt),
    details,
  };
}

function toWireOutcome(entry: SupplierOutcomeEntry): { supplier: string; outcome: string } {
  return {
    supplier: entry.supplier,
    // Traveller-safe language — never internal error text (policy A10 / BR-13).
    outcome: entry.outcome === 'SUCCEEDED'
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

export interface FlightSearchControllerDeps {
  flightSearchService: IFlightSearchService;
}

export function createFlightSearchController(deps: FlightSearchControllerDeps) {
  const { flightSearchService } = deps;

  return async function flightSearchHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Body already validated and coerced by validateRequest middleware.
      const body = (req as Request & { validated?: { body?: FlightSearchRequest } })
        .validated?.body as FlightSearchRequest;

      // Resolve correlation ID — set by correlationIdMiddleware or x-trace-id header.
      const correlationId: string =
        (req as Request & { correlationId?: string }).correlationId ??
        (req.headers['x-trace-id'] as string | undefined) ??
        'unknown';

      const result = await flightSearchService.search(body, correlationId);

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
      // Map known supplier errors to the shared error envelope.
      if (err instanceof SupplierTimeoutError) {
        const domainErr = supplierTimeout();
        const correlationId: string =
          (req as Request & { correlationId?: string }).correlationId ??
          (req.headers['x-trace-id'] as string | undefined) ??
          'unknown';
        const { envelope, status } = serialiseError(domainErr, correlationId);
        res.status(status).json(envelope);
        return;
      }

      if (err instanceof SupplierRejectedRequestError) {
        const domainErr = supplierRejected(
          // Never forward internal provider text to the response body (BR-13).
          'The supplier rejected the flight search request.',
        );
        const correlationId: string =
          (req as Request & { correlationId?: string }).correlationId ??
          (req.headers['x-trace-id'] as string | undefined) ??
          'unknown';
        const { envelope, status } = serialiseError(domainErr, correlationId);
        res.status(status).json(envelope);
        return;
      }

      // All other errors forwarded to the shared error handler (500 with
      // correlation ID, no stack trace in response — enforced by errorHandler.ts).
      next(err);
    }
  };
}
