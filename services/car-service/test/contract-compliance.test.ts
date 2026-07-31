/**
 * SupplierPort contract-compliance suite for RapidApiCarAdapter.
 *
 * Exercises the structural requirements from WO-025 against recorded fixtures.
 * Zero live API calls are made — all HTTP is handled by in-memory stubs.
 *
 * Mirrors the harness in packages/supplier-port/test/contract-compliance.ts
 * without depending on the compiled supplier-port dist.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SupplierError,
  SupplierTimeoutError,
  SupplierUnavailableError,
  SupplierRejectedRequestError,
  SupplierEgressBlockedError,
  isSupplierError,
} from '@travel/supplier-port';
import type { SupplierPort, SearchCriteria, SupplierHttpClient } from '@travel/supplier-port';
import { RapidApiCarAdapter } from '../src/adapters/RapidApiCarAdapter.js';
import emptyFixture from './fixtures/rapidapi-car/empty-results.json';
import multiFixture from './fixtures/rapidapi-car/multi-vehicle-success.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(fixture: unknown = emptyFixture): SupplierPort {
  const httpClient = {
    request: async () => ({
      status: 200,
      headers: {},
      ok: true,
      text: async () => JSON.stringify(fixture),
      json: async () => fixture as unknown,
    }),
  } as unknown as SupplierHttpClient;

  return new RapidApiCarAdapter({
    httpClient,
    clock: { now: () => Date.now(), sleep: async () => {} },
    config: {
      searchEndpoint: 'https://test-cars.p.rapidapi.com/cars/search',
      apiHost: 'test-cars.p.rapidapi.com',
      apiKey: 'compliance-test-key',
      defaultOfferValidityMinutes: 30,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ---------------------------------------------------------------------------
// SupplierPort compliance — structural assertions
// ---------------------------------------------------------------------------

describe('SupplierPort compliance — RapidApiCarAdapter', () => {
  let adapter: SupplierPort;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('declares at least one supported flow', () => {
    expect(adapter.supportedFlows.length).toBeGreaterThan(0);
  });

  it('declares a non-empty supplierName', () => {
    expect(typeof adapter.supplierName).toBe('string');
    expect(adapter.supplierName.trim().length).toBeGreaterThan(0);
  });

  it('exposes a searchOffers method', () => {
    expect(typeof adapter.searchOffers).toBe('function');
  });

  it('supportedFlows contains only valid SupplierFlowShape values', () => {
    const validShapes = new Set(['INSTANT', 'RESERVE_THEN_CONFIRM', 'ARI_PUSH']);
    for (const flow of adapter.supportedFlows) {
      expect(validShapes.has(flow)).toBe(true);
    }
  });

  it('flowShape is INSTANT (as required by WO-028)', () => {
    expect(adapter.supportedFlows).toContain('INSTANT');
  });

  it('adapter does NOT implement reserve/confirm (INSTANT-only)', () => {
    expect((adapter as unknown as Record<string, unknown>)['reserve']).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>)['confirm']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SupplierError hierarchy compliance
// ---------------------------------------------------------------------------

describe('SupplierError hierarchy compliance', () => {
  it('SupplierError subclasses satisfy isSupplierError type guard', () => {
    expect(isSupplierError(new SupplierTimeoutError('s', 'c', 2200))).toBe(true);
    expect(isSupplierError(new SupplierUnavailableError('s', 'c', 503))).toBe(true);
    expect(isSupplierError(new SupplierRejectedRequestError('s', 'c', 422))).toBe(true);
    expect(isSupplierError(new SupplierEgressBlockedError('s', 'c', 'evil.example.com'))).toBe(true);
    expect(isSupplierError(new Error('plain'))).toBe(false);
  });

  it('SupplierError subclasses carry supplierName and correlationId', () => {
    const err = new SupplierTimeoutError('car-co', 'req-001', 2200);
    expect(err.supplierName).toBe('car-co');
    expect(err.correlationId).toBe('req-001');
    expect(err.timeoutMs).toBe(2200);
    expect(err.name).toBe('SupplierTimeoutError');
  });

  it('SupplierError subclasses have correct prototype chain', () => {
    const timeout = new SupplierTimeoutError('s', 'c', 1000);
    expect(timeout).toBeInstanceOf(SupplierError);
    expect(timeout).toBeInstanceOf(SupplierTimeoutError);
    expect(timeout).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// searchOffers contract — must return Offer[] or throw SupplierError
// ---------------------------------------------------------------------------

const SAMPLE_CRITERIA: Record<string, SearchCriteria> = {
  car: {
    kind: 'car',
    pickupLocation: 'JFK',
    dropoffLocation: 'JFK',
    pickupDate: new Date('2028-03-15T00:00:00Z'),
    dropoffDate: new Date('2028-03-18T00:00:00Z'),
    carClass: 'ECONOMY',
    currency: 'USD',
  },
  hotel: {
    kind: 'hotel',
    location: 'New York',
    checkInDate: new Date('2028-03-15T00:00:00Z'),
    checkOutDate: new Date('2028-03-18T00:00:00Z'),
    guests: 2,
    currency: 'USD',
  },
  flight: {
    kind: 'flight',
    departureAirport: 'LHR',
    arrivalAirport: 'JFK',
    departureDate: new Date('2028-03-15T00:00:00Z'),
    passengers: 1,
    seatClass: 'ECONOMY',
    currency: 'USD',
  },
};

for (const [kind, criteria] of Object.entries(SAMPLE_CRITERIA)) {
  describe(`searchOffers with ${kind} criteria`, () => {
    it('resolves or throws SupplierError only', async () => {
      const a = makeAdapter(emptyFixture);
      try {
        const result = await a.searchOffers(criteria, 'compliance-corr');
        expect(Array.isArray(result)).toBe(true);
      } catch (err) {
        expect(isSupplierError(err)).toBe(true);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Multi-vehicle fixture — validate Offer shape
// ---------------------------------------------------------------------------

describe('searchOffers — multi-vehicle fixture', () => {
  const CAR_CRITERIA: SearchCriteria = SAMPLE_CRITERIA['car']!;

  it('returns 3 offers from the multi-vehicle fixture', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    expect(offers).toHaveLength(3);
  });

  it('every returned offer has a non-empty id', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.id).toBe('string');
      expect(offer.id.length).toBeGreaterThan(0);
    }
  });

  it('every returned offer has provenance RAPIDAPI and bookable true', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.provenance).toBe('RAPIDAPI');
      expect(offer.bookable).toBe(true);
    }
  });

  it('every returned offer has a positive price and 3-letter currency', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.price).toBe('number');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('every returned offer has an expiresAt Date', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.expiresAt).toBeInstanceOf(Date);
    }
  });

  it('every returned offer has a non-empty title', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.title).toBe('string');
      expect(offer.title.length).toBeGreaterThan(0);
    }
  });

  it('every returned offer has freshness FRESH', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.freshness).toBe('FRESH');
    }
  });

  it('details contains totalPrice, rentalDays, vehicleClass, and supplier', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      const details = offer.details as Record<string, unknown>;
      expect(details['supplier']).toBe('RAPIDAPI');
      expect(typeof details['totalPrice']).toBe('number');
      expect(typeof details['rentalDays']).toBe('number');
      expect(typeof details['vehicleClass']).toBe('string');
    }
  });

  it('details.vehicleClass is a canonical value or UNKNOWN', async () => {
    const valid = new Set(['ECONOMY', 'COMPACT', 'MIDSIZE', 'PREMIUM', 'UNKNOWN']);
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    for (const offer of offers) {
      const vc = (offer.details as Record<string, unknown>)['vehicleClass'];
      expect(typeof vc).toBe('string');
      expect(valid.has(vc as string)).toBe(true);
    }
  });

  it('offer IDs are unique across all offers in the same response', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(CAR_CRITERIA, 'compliance-corr');
    const ids = offers.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
