/**
 * Unit tests for CarSearchController.
 *
 * Covers (AC8):
 *  - Wire offer shape: vehicleClass (including UNKNOWN), totalPrice, currency,
 *    pickupLocationId, dropoffLocationId, supplier, provenance, bookable, expiresAt
 *  - Supplier outcome traveller-safe label mapping
 *  - SupplierTimeoutError → 504
 *  - SupplierRejectedRequestError → 422
 *  - Empty state propagated to response
 */

import { describe, it, expect, vi } from 'vitest';
import { createCarSearchController } from '../../src/controllers/CarSearchController.js';
import type { ICarSearchService, CarSearchResult, SupplierOutcomeEntry } from '../../src/domain/CarSearchService.js';
import { SupplierTimeoutError, SupplierRejectedRequestError } from '@travel/supplier-port';
import type { Request, Response, NextFunction } from 'express';
import type { Offer } from '@travel/contracts';
import type { RankedOffer } from '@travel/offer-normaliser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOffer(id: string, vehicleClass = 'ECONOMY', totalPrice = 120): Offer {
  return {
    id,
    provenance: 'RAPIDAPI',
    bookable: true,
    title: 'Toyota Yaris',
    price: totalPrice,
    currency: 'USD',
    details: {
      supplier: 'RAPIDAPI',
      vehicleClass,
      pickupLocation: 'JFK',
      dropoffLocation: 'LAX',
      totalPrice,
    },
    expiresAt: new Date('2099-12-31T23:59:59.000Z'),
    freshness: 'FRESH',
  };
}

function makeRankedOffer(offer: Offer): RankedOffer {
  return { offer };
}

function makeServiceResult(overrides: Partial<CarSearchResult> = {}): CarSearchResult {
  return {
    offers: [makeRankedOffer(makeOffer('o-1'))],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
    freshness: { generatedAt: new Date('2099-06-15T12:00:00.000Z'), stale: false },
    ...overrides,
  };
}

function makeMockService(result: CarSearchResult | Error): ICarSearchService {
  return {
    search: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function makeMockReq(validatedBody: unknown = {}): Request {
  return {
    validated: { body: validatedBody },
    headers: { 'x-trace-id': 'test-trace-id' },
    correlationId: 'test-cid',
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Wire offer shape
// ---------------------------------------------------------------------------

describe('CarSearchController — toWireOffer', () => {
  it('includes required fields in each offer', async () => {
    const svc = makeMockService(makeServiceResult());
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const offer = (res.body as Record<string, unknown[]>)['offers'][0] as Record<string, unknown>;
    expect(offer).toMatchObject({
      id: expect.any(String),
      vehicleClass: expect.any(String),
      totalPrice: expect.any(Number),
      currency: expect.any(String),
      pickupLocationId: expect.any(String),
      dropoffLocationId: expect.any(String),
      supplier: expect.any(String),
      provenance: expect.any(String),
      bookable: expect.any(Boolean),
      expiresAt: expect.any(String),
    });
  });

  it('passes UNKNOWN vehicleClass through without substitution', async () => {
    const svc = makeMockService(makeServiceResult({
      offers: [makeRankedOffer(makeOffer('u-1', 'UNKNOWN'))],
    }));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const offer = (res.body as Record<string, unknown[]>)['offers'][0] as Record<string, unknown>;
    expect(offer['vehicleClass']).toBe('UNKNOWN');
  });

  it('uses details.totalPrice when available', async () => {
    const svc = makeMockService(makeServiceResult({
      offers: [makeRankedOffer(makeOffer('o-1', 'ECONOMY', 299))],
    }));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const offer = (res.body as Record<string, unknown[]>)['offers'][0] as Record<string, unknown>;
    expect(offer['totalPrice']).toBe(299);
  });

  it('formats expiresAt as ISO string', async () => {
    const svc = makeMockService(makeServiceResult());
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const offer = (res.body as Record<string, unknown[]>)['offers'][0] as Record<string, unknown>;
    expect(() => new Date(offer['expiresAt'] as string)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Supplier outcome mapping
// ---------------------------------------------------------------------------

describe('CarSearchController — outcome labels', () => {
  const cases: [SupplierOutcomeEntry['outcome'], string][] = [
    ['SUCCEEDED', 'available'],
    ['FAILED', 'unavailable'],
    ['TIMED_OUT', 'timed out'],
    ['SKIPPED_CIRCUIT_OPEN', 'temporarily unavailable'],
  ];

  for (const [outcome, label] of cases) {
    it(`maps ${outcome} → "${label}"`, async () => {
      const svc = makeMockService(makeServiceResult({
        supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome }],
      }));
      const handler = createCarSearchController({ carSearchService: svc });
      const res = makeMockRes();
      await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

      const outcomes = (res.body as Record<string, unknown[]>)['supplierOutcomes'];
      expect(outcomes[0]).toMatchObject({ outcome: label });
    });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('CarSearchController — error handling', () => {
  it('returns 504 for SupplierTimeoutError', async () => {
    const svc = makeMockService(new SupplierTimeoutError('RAPIDAPI', 'cid', 2200));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    const next = vi.fn();
    await handler(makeMockReq(), res, next as unknown as NextFunction);
    expect(res.statusCode).toBe(504);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 422 for SupplierRejectedRequestError', async () => {
    const svc = makeMockService(new SupplierRejectedRequestError('RAPIDAPI', 'cid', 422));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    const next = vi.fn();
    await handler(makeMockReq(), res, next as unknown as NextFunction);
    expect(res.statusCode).toBe(422);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for unexpected errors', async () => {
    const svc = makeMockService(new Error('unexpected'));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    const next = vi.fn();
    await handler(makeMockReq(), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('CarSearchController — empty state', () => {
  it('includes emptyState in response when present', async () => {
    const svc = makeMockService(makeServiceResult({
      offers: [],
      emptyState: {
        reason: 'No availability',
        alternativePickupWindows: [
          { pickupDate: '2099-06-20T12:00:00.000Z', dropoffDate: '2099-06-23T12:00:00.000Z' },
        ],
      },
    }));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const body = res.body as Record<string, unknown>;
    expect(body['emptyState']).toMatchObject({
      reason: expect.any(String),
      alternativePickupWindows: expect.any(Array),
    });
  });

  it('omits emptyState when result has offers', async () => {
    const svc = makeMockService(makeServiceResult());
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const body = res.body as Record<string, unknown>;
    expect(body['emptyState']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe('CarSearchController — freshness', () => {
  it('includes freshness.generatedAt as ISO string and stale flag', async () => {
    const svc = makeMockService(makeServiceResult({
      freshness: { generatedAt: new Date('2099-06-15T12:00:00.000Z'), stale: true },
    }));
    const handler = createCarSearchController({ carSearchService: svc });
    const res = makeMockRes();
    await handler(makeMockReq(), res, vi.fn() as unknown as NextFunction);

    const freshness = (res.body as Record<string, unknown>)['freshness'] as Record<string, unknown>;
    expect(freshness['stale']).toBe(true);
    expect(typeof freshness['generatedAt']).toBe('string');
  });
});
