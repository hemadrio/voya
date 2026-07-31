/**
 * SupplierPort contract-compliance suite for RapidApiHotelAdapter.
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
import { RapidApiHotelAdapter } from '../src/adapters/RapidApiHotelAdapter.js';
import emptyFixture from './fixtures/rapidapi-hotel/empty-results.json';
import multiFixture from './fixtures/rapidapi-hotel/multi-property-success.json';

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

  return new RapidApiHotelAdapter({
    httpClient,
    clock: { now: () => Date.now(), sleep: async () => {} },
    config: {
      searchEndpoint: 'https://test-hotels.p.rapidapi.com/hotels/search',
      apiHost: 'test-hotels.p.rapidapi.com',
      apiKey: 'compliance-test-key',
      defaultOfferValidityMinutes: 30,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ---------------------------------------------------------------------------
// SupplierPort compliance — structural assertions
// ---------------------------------------------------------------------------

describe('SupplierPort compliance — RapidApiHotelAdapter', () => {
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

  it('flowShape is INSTANT (as required by WO-027)', () => {
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
    const err = new SupplierTimeoutError('hotel-co', 'req-001', 2200);
    expect(err.supplierName).toBe('hotel-co');
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
  car: {
    kind: 'car',
    pickupLocation: 'JFK',
    dropoffLocation: 'JFK',
    pickupDate: new Date('2028-03-15T00:00:00Z'),
    dropoffDate: new Date('2028-03-18T00:00:00Z'),
    carClass: 'ECONOMY',
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
// Multi-property fixture — validate Offer shape
// ---------------------------------------------------------------------------

describe('searchOffers — multi-property fixture', () => {
  it('returns 2 offers from the multi-property fixture', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    expect(offers).toHaveLength(2);
  });

  it('every returned offer has a non-empty id', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.id).toBe('string');
      expect(offer.id.length).toBeGreaterThan(0);
    }
  });

  it('every returned offer has provenance RAPIDAPI and bookable true', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.provenance).toBe('RAPIDAPI');
      expect(offer.bookable).toBe(true);
    }
  });

  it('every returned offer has a positive price and 3-letter currency', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.price).toBe('number');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('every returned offer has an expiresAt Date', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.expiresAt).toBeInstanceOf(Date);
    }
  });

  it('every returned offer has a non-empty title (property name)', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.title).toBe('string');
      expect(offer.title.length).toBeGreaterThan(0);
    }
  });

  it('offers with star ratings have rating in [0, 5]', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      if (offer.rating !== undefined) {
        expect(offer.rating).toBeGreaterThanOrEqual(0);
        expect(offer.rating).toBeLessThanOrEqual(5);
      }
    }
  });

  it('offers with review counts have non-negative integer reviews', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      if (offer.reviews !== undefined) {
        expect(typeof offer.reviews).toBe('number');
        expect(offer.reviews).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(offer.reviews)).toBe(true);
      }
    }
  });

  it('details contains totalPrice, nightlyPrice, nights, and supplier', async () => {
    const a = makeAdapter(multiFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['hotel']!, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.details['supplier']).toBe('RAPIDAPI');
      expect(typeof offer.details['totalPrice']).toBe('number');
      expect(typeof offer.details['nightlyPrice']).toBe('number');
      expect(typeof offer.details['nights']).toBe('number');
    }
  });
});
