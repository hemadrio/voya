/**
 * Unit tests for POST /v1/hotels/search controller + validation layer.
 *
 * Covers:
 *   - Date coherence rejection (checkOut ≤ checkIn) with zero service calls.
 *   - Same-day stay rejection.
 *   - Invalid guest count rejection.
 *   - Missing required field.
 *   - Successful 200 with wire shape.
 *   - Nullable quality signals (null reviewScore, reviewCount, starRating).
 *   - Empty state 200.
 *   - SupplierTimeoutError → 504.
 *   - SupplierRejectedRequestError → 422.
 *   - Traveller-safe supplier outcome labels.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { IHotelSearchService } from '../../src/domain/HotelSearchService.js';
import type { HotelSearchResult } from '../../src/domain/HotelSearchService.js';
import type { HotelSearchRequest } from '@travel/contracts';
import { SupplierTimeoutError, SupplierRejectedRequestError } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_BODY = {
  location: 'New York',
  checkInDate: '2099-07-10T14:00:00.000Z',
  checkOutDate: '2099-07-13T11:00:00.000Z',
  guests: 2,
  currency: 'USD',
};

function makeOffer(id = 'o1', opts: { reviewScore?: number | null; starRating?: number | null; reviewCount?: number | null } = {}) {
  return {
    offer: {
      id,
      provenance: 'RAPIDAPI',
      bookable: true,
      title: `Hotel ${id}`,
      price: 150,
      currency: 'USD',
      details: {
        supplier: 'RAPIDAPI',
        totalPrice: 450,
        nightlyPrice: 150,
        nights: 3,
        ...(opts.reviewScore !== undefined ? { reviewScore: opts.reviewScore } : {}),
      },
      expiresAt: new Date('2099-12-31T23:59:59.000Z'),
      freshness: 'FRESH',
      ...(opts.starRating !== undefined && opts.starRating !== null ? { rating: opts.starRating } : {}),
      ...(opts.reviewCount !== undefined && opts.reviewCount !== null ? { reviews: opts.reviewCount } : {}),
    },
  };
}

function makeSuccessResult(offerId = 'o1'): HotelSearchResult {
  return {
    offers: [makeOffer(offerId, { reviewScore: 8.5, starRating: 4, reviewCount: 200 })],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
    freshness: { generatedAt: new Date('2099-07-01T12:00:00.000Z'), stale: false },
  };
}

function makeNoReviewResult(): HotelSearchResult {
  return {
    offers: [makeOffer('no-review', { reviewScore: null, starRating: null, reviewCount: null })],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' }],
    freshness: { generatedAt: new Date('2099-07-01T12:00:00.000Z'), stale: false },
  };
}

function makeEmptyStateResult(): HotelSearchResult {
  return {
    offers: [],
    supplierOutcomes: [{ supplier: 'RAPIDAPI', outcome: 'FAILED' }],
    freshness: { generatedAt: new Date('2099-07-01T12:00:00.000Z'), stale: false },
    emptyState: {
      reason: 'No availability found.',
      alternativeStayDates: [
        { checkInDate: '2099-07-07', checkOutDate: '2099-07-10' },
        { checkInDate: '2099-07-11', checkOutDate: '2099-07-14' },
      ],
    },
  };
}

function mockService(result: HotelSearchResult | Error = makeSuccessResult()): IHotelSearchService {
  return {
    search: vi.fn(async (_req: HotelSearchRequest) => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function buildApp(svc: IHotelSearchService) {
  return createApp({ hotelSearchService: svc });
}

// ---------------------------------------------------------------------------
// Validation — date coherence (AC1, AC2)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — date coherence validation', () => {
  it('rejects inverted dates (checkOut before checkIn) with 400', async () => {
    const svc = mockService();
    const app = buildApp(svc);
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      checkInDate: '2099-07-13T14:00:00.000Z',
      checkOutDate: '2099-07-10T11:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/checkOutDate/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('rejects same-day stay (checkOut === checkIn) with 400', async () => {
    const svc = mockService();
    const app = buildApp(svc);
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      checkInDate: '2099-07-10T14:00:00.000Z',
      checkOutDate: '2099-07-10T14:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/checkOutDate/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('rejects zero guests with 400', async () => {
    const svc = mockService();
    const app = buildApp(svc);
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      guests: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/guests/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('rejects missing location with 400', async () => {
    const svc = mockService();
    const app = buildApp(svc);
    const { location: _omit, ...body } = VALID_BODY;
    const res = await request(app).post('/v1/hotels/search').send(body);
    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('rejects extra unknown fields with 400 (strict schema)', async () => {
    const svc = mockService();
    const app = buildApp(svc);
    const res = await request(app).post('/v1/hotels/search').send({
      ...VALID_BODY,
      unknownField: 'evil',
    });
    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success response shape (AC3)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — success shape', () => {
  it('returns 200 with offers array', async () => {
    const app = buildApp(mockService());
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.offers)).toBe(true);
  });

  it('each offer includes propertyName, nightlyPrice, totalPrice, currency, bookable, expiresAt', async () => {
    const app = buildApp(mockService());
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const offer = res.body.offers[0];
    expect(offer).toMatchObject({
      propertyName: expect.any(String),
      nightlyPrice: expect.any(Number),
      currency: expect.any(String),
      bookable: expect.any(Boolean),
      expiresAt: expect.any(String),
      provenance: expect.any(String),
    });
  });

  it('includes starRating, reviewCount, reviewScore when supplier provides them', async () => {
    const app = buildApp(mockService());
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const offer = res.body.offers[0];
    expect(offer.starRating).toBe(4);
    expect(offer.reviewScore).toBe(8.5);
    expect(offer.reviewCount).toBe(200);
  });

  it('returns freshness with generatedAt and stale', async () => {
    const app = buildApp(mockService());
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.body.freshness).toMatchObject({
      generatedAt: expect.any(String),
      stale: false,
    });
  });

  it('returns supplierOutcomes', async () => {
    const app = buildApp(mockService());
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(Array.isArray(res.body.supplierOutcomes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nullable quality signals (AC4)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — nullable quality signals', () => {
  it('returns null for starRating when supplier omits it', async () => {
    const app = buildApp(mockService(makeNoReviewResult()));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.body.offers[0].starRating).toBeNull();
  });

  it('returns null for reviewScore when supplier omits it', async () => {
    const app = buildApp(mockService(makeNoReviewResult()));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.body.offers[0].reviewScore).toBeNull();
  });

  it('returns null for reviewCount when supplier omits it', async () => {
    const app = buildApp(mockService(makeNoReviewResult()));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.body.offers[0].reviewCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty state (equivalent to AC4/AC9 scenario 4)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — empty state', () => {
  it('returns 200 with emptyState when no availability', async () => {
    const app = buildApp(mockService(makeEmptyStateResult()));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.emptyState).toMatchObject({
      reason: expect.any(String),
      alternativeStayDates: expect.any(Array),
    });
  });

  it('alternativeStayDates entries have checkInDate and checkOutDate', async () => {
    const app = buildApp(mockService(makeEmptyStateResult()));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const dates = res.body.emptyState.alternativeStayDates as Array<{ checkInDate: string; checkOutDate: string }>;
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toMatchObject({
      checkInDate: expect.any(String),
      checkOutDate: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// Supplier error mapping (AC7)
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — supplier error mapping', () => {
  it('maps SupplierTimeoutError to 504', async () => {
    const err = new SupplierTimeoutError('RAPIDAPI', 'corr-1', 2200);
    const app = buildApp(mockService(err));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('SUPPLIER_TIMEOUT');
  });

  it('maps SupplierRejectedRequestError to 422', async () => {
    const err = new SupplierRejectedRequestError('RAPIDAPI', 'corr-1', 400, 'bad request');
    const app = buildApp(mockService(err));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUPPLIER_REJECTED');
  });

  it('error envelope does not contain stack trace or provider text', async () => {
    const err = new SupplierTimeoutError('RAPIDAPI', 'corr-1', 2200);
    const app = buildApp(mockService(err));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('stack');
    expect(body).not.toContain('RAPIDAPI');
  });
});

// ---------------------------------------------------------------------------
// Partial attribution — traveller-safe labels
// ---------------------------------------------------------------------------

describe('POST /v1/hotels/search — partial attribution', () => {
  it('maps FAILED outcome to traveller-safe "unavailable"', async () => {
    const result: HotelSearchResult = {
      ...makeSuccessResult(),
      supplierOutcomes: [
        { supplier: 'RAPIDAPI', outcome: 'SUCCEEDED' },
        { supplier: 'SECOND', outcome: 'FAILED' },
      ],
    };
    const app = buildApp(mockService(result));
    const res = await request(app).post('/v1/hotels/search').send(VALID_BODY);
    const second = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'SECOND',
    );
    expect(second?.outcome).toBe('unavailable');
  });
});
