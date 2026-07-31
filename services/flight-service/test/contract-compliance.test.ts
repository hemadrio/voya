/**
 * SupplierPort contract-compliance suite for AmadeusFlightAdapter.
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
import { AmadeusFlightAdapter } from '../src/adapters/AmadeusFlightAdapter.js';
import { AmadeusTokenProvider } from '../src/adapters/AmadeusTokenProvider.js';
import emptyFixture from './fixtures/amadeus/empty-availability.json';
import multiOfferFixture from './fixtures/amadeus/multi-offer-search.json';

// ---------------------------------------------------------------------------
// Helpers — same in-memory doubles as unit tests
// ---------------------------------------------------------------------------

function makeTokenProvider(token = 'compliance-test-token'): AmadeusTokenProvider {
  const redis = {
    get: async () => null as string | null,
    set: async () => undefined as unknown,
    del: async () => undefined as unknown,
  };
  const httpClient = {
    post: async () => ({
      status: 200,
      json: async () => ({ access_token: token, expires_in: 1799 }),
    }),
  };
  return new AmadeusTokenProvider({
    redis,
    httpClient,
    clock: { now: () => 0, sleep: async () => {} },
    config: {
      clientId: 'test-id',
      clientSecret: 'test-secret',
      tokenEndpoint: 'https://test.api.amadeus.com/v1/security/oauth2/token',
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

function makeAdapter(fixture: unknown = emptyFixture): SupplierPort {
  const httpClient = {
    request: async () => ({
      status: 200,
      headers: {},
      ok: true,
      text: async () => JSON.stringify(fixture),
      json: async <T>() => fixture as T,
    }),
  } as unknown as SupplierHttpClient;

  return new AmadeusFlightAdapter({
    tokenProvider: makeTokenProvider(),
    httpClient,
    clock: { now: () => Date.now(), sleep: async () => {} },
    config: {
      searchEndpoint: 'https://test.api.amadeus.com/v2/shopping/flight-offers',
      defaultOfferValidityMinutes: 60,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ---------------------------------------------------------------------------
// Contract compliance — structural assertions (mirrors WO-025 harness)
// ---------------------------------------------------------------------------

describe('SupplierPort compliance — AmadeusFlightAdapter', () => {
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

  it('flowShape is INSTANT (as required by WO-026)', () => {
    expect(adapter.supportedFlows).toContain('INSTANT');
  });

  it('adapter does NOT implement reserve/confirm (INSTANT-only)', () => {
    expect(adapter.reserve).toBeUndefined();
    expect(adapter.confirm).toBeUndefined();
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
    const err = new SupplierTimeoutError('flight-co', 'req-001', 2200);
    expect(err.supplierName).toBe('flight-co');
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
  flight: {
    kind: 'flight',
    departureAirport: 'LHR',
    arrivalAirport: 'JFK',
    departureDate: new Date('2028-03-15T00:00:00Z'),
    passengers: 1,
    seatClass: 'ECONOMY',
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
// Multi-offer fixture — validate Offer shape
// ---------------------------------------------------------------------------

describe('searchOffers — multi-offer fixture', () => {
  it('returns 2 offers from the multi-offer fixture', async () => {
    const a = makeAdapter(multiOfferFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['flight']!, 'compliance-corr');
    expect(offers).toHaveLength(2);
  });

  it('every returned offer has a non-empty id', async () => {
    const a = makeAdapter(multiOfferFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['flight']!, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.id).toBe('string');
      expect(offer.id.length).toBeGreaterThan(0);
    }
  });

  it('every returned offer has provenance AMADEUS and bookable true', async () => {
    const a = makeAdapter(multiOfferFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['flight']!, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.provenance).toBe('AMADEUS');
      expect(offer.bookable).toBe(true);
    }
  });

  it('every returned offer has a positive price and 3-letter currency', async () => {
    const a = makeAdapter(multiOfferFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['flight']!, 'compliance-corr');
    for (const offer of offers) {
      expect(typeof offer.price).toBe('number');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('every returned offer has an expiresAt Date', async () => {
    const a = makeAdapter(multiOfferFixture);
    const offers = await a.searchOffers(SAMPLE_CRITERIA['flight']!, 'compliance-corr');
    for (const offer of offers) {
      expect(offer.expiresAt).toBeInstanceOf(Date);
    }
  });
});
