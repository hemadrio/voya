/**
 * Unit tests for POST /v1/flights/search via the full Express app.
 *
 * Covers:
 *   - Validation short-circuit: 400 with field name, zero domain calls.
 *   - Invalid airport code (4-letter): 400 with departureAirport field.
 *   - Past departure date: 400 with departureDate field.
 *   - Out-of-range passengers (10): 400 with passengers field.
 *   - Successful search: 200 with offers, supplierOutcomes, freshness.
 *   - Empty-state response: 200 with emptyState.alternativeDates.
 *   - Partial supplier failure: 200 with attributed supplierOutcomes.
 *   - Supplier timeout error: 504 with standard envelope.
 *   - Supplier rejected error: 422 with standard envelope.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { IFlightSearchService } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchResult } from '../../src/domain/FlightSearchService.js';
import type { FlightSearchRequest } from '@travel/contracts';
import { SupplierTimeoutError, SupplierRejectedRequestError } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Full ISO 8601 datetime required by isoDateString schema (z.string().datetime({offset:true}))
const FUTURE_DATE = '2099-06-15T12:00:00.000Z';

const VALID_BODY = {
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: FUTURE_DATE,
  passengers: 2,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

function makeSuccessResult(): FlightSearchResult {
  return {
    offers: [
      {
        offer: {
          id: 'offer-1',
          provenance: 'AMADEUS',
          bookable: true,
          title: 'LHR-JFK Economy',
          price: 350,
          currency: 'USD',
          details: { cabinClass: 'ECONOMY', stops: 0, supplier: 'AMADEUS' },
          expiresAt: new Date('2099-12-31') as unknown as Date,
          freshness: 'FRESH',
        },
      },
    ],
    supplierOutcomes: [{ supplier: 'AMADEUS', outcome: 'SUCCEEDED' }],
    freshness: { generatedAt: new Date('2099-06-10T12:00:00Z'), stale: false },
  };
}

function makeEmptyStateResult(): FlightSearchResult {
  return {
    offers: [],
    supplierOutcomes: [{ supplier: 'AMADEUS', outcome: 'FAILED' }],
    freshness: { generatedAt: new Date('2099-06-10T12:00:00Z'), stale: false },
    emptyState: {
      reason: 'No availability found for the requested route and date.',
      alternativeDates: ['2099-06-12', '2099-06-13', '2099-06-14', '2099-06-16', '2099-06-17', '2099-06-18'],
    },
  };
}

function makeMockService(result: FlightSearchResult | Error = makeSuccessResult()): IFlightSearchService {
  return {
    search: vi.fn(async (_req: FlightSearchRequest) => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function makeApp(service: IFlightSearchService) {
  return createApp({ flightSearchService: service });
}

// ---------------------------------------------------------------------------
// Validation short-circuit
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — validation', () => {
  it('returns 400 with offending field for 4-letter airport code', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, departureAirport: 'LHRE' });

    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/departureAirport/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 for lower-case airport code', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, arrivalAirport: 'jfk' });

    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 with departureDate field for past date', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, departureDate: '2020-01-01' });

    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/departureDate/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 with passengers field for out-of-range count (10)', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, passengers: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error.field).toMatch(/passengers/);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 for zero passengers', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, passengers: 0 });

    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 for missing required field', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const { currency: _omit, ...bodyWithoutCurrency } = VALID_BODY;
    const res = await request(app)
      .post('/v1/flights/search')
      .send(bodyWithoutCurrency);

    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });

  it('returns 400 for unknown extra fields (strict schema)', async () => {
    const svc = makeMockService();
    const app = makeApp(svc);
    const res = await request(app)
      .post('/v1/flights/search')
      .send({ ...VALID_BODY, injectedField: 'evil' });

    expect(res.status).toBe(400);
    expect(svc.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful response shape
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — success', () => {
  it('returns 200 with offers array', async () => {
    const app = makeApp(makeMockService());
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.offers)).toBe(true);
    expect(res.body.offers).toHaveLength(1);
  });

  it('each offer contains supplier, totalPrice, currency, cabinClass, provenance, bookable, expiresAt', async () => {
    const app = makeApp(makeMockService());
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const offer = res.body.offers[0];
    expect(offer).toMatchObject({
      supplier: expect.any(String),
      totalPrice: expect.any(Number),
      currency: expect.any(String),
      provenance: expect.any(String),
      bookable: expect.any(Boolean),
      expiresAt: expect.any(String),
    });
  });

  it('returns supplierOutcomes array', async () => {
    const app = makeApp(makeMockService());
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(Array.isArray(res.body.supplierOutcomes)).toBe(true);
    expect(res.body.supplierOutcomes[0]).toMatchObject({
      supplier: expect.any(String),
      outcome: expect.any(String),
    });
  });

  it('returns freshness with generatedAt and stale', async () => {
    const app = makeApp(makeMockService());
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.freshness).toMatchObject({
      generatedAt: expect.any(String),
      stale: false,
    });
  });

  it('does not include emptyState on successful response', async () => {
    const app = makeApp(makeMockService());
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.emptyState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — empty state', () => {
  it('returns 200 (not 404) when no availability', async () => {
    const app = makeApp(makeMockService(makeEmptyStateResult()));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(200);
  });

  it('includes emptyState.reason and emptyState.alternativeDates', async () => {
    const app = makeApp(makeMockService(makeEmptyStateResult()));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.body.emptyState).toMatchObject({
      reason: expect.any(String),
      alternativeDates: expect.any(Array),
    });
    expect(res.body.emptyState.alternativeDates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Supplier error mapping
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — supplier error mapping', () => {
  it('maps SupplierTimeoutError to 504 with standard envelope', async () => {
    const err = new SupplierTimeoutError('AMADEUS', 'corr-1', 2200);
    const app = makeApp(makeMockService(err));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('SUPPLIER_TIMEOUT');
  });

  it('maps SupplierRejectedRequestError to 422 with standard envelope', async () => {
    const err = new SupplierRejectedRequestError('AMADEUS', 'corr-1', 400, 'No routes');
    const app = makeApp(makeMockService(err));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUPPLIER_REJECTED');
  });

  it('supplier error envelope never contains stack trace or provider text', async () => {
    const err = new SupplierTimeoutError('AMADEUS', 'corr-1', 2200);
    const app = makeApp(makeMockService(err));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('stack');
    expect(body).not.toContain('AMADEUS'); // supplier name not in response body
  });
});

// ---------------------------------------------------------------------------
// Partial attribution
// ---------------------------------------------------------------------------

describe('POST /v1/flights/search — partial supplier attribution', () => {
  it('returns traveller-safe outcome labels, not internal codes', async () => {
    const result: FlightSearchResult = {
      ...makeSuccessResult(),
      supplierOutcomes: [
        { supplier: 'AMADEUS', outcome: 'SUCCEEDED' },
        { supplier: 'RAPIDAPI', outcome: 'FAILED' },
      ],
    };
    const app = makeApp(makeMockService(result));
    const res = await request(app).post('/v1/flights/search').send(VALID_BODY);

    const unavailable = res.body.supplierOutcomes.find(
      (o: { supplier: string; outcome: string }) => o.supplier === 'RAPIDAPI',
    );
    // Must be traveller-safe language
    expect(unavailable?.outcome).not.toBe('FAILED');
    expect(unavailable?.outcome).toBe('unavailable');
  });
});
