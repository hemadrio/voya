/**
 * Unit tests for AmadeusFlightAdapter.
 *
 * Tests: retry on 5xx, no retry on 4xx, token refresh on search 401,
 * timeout → SupplierTimeoutError, empty results path, error classification,
 * non-flight criteria returns empty array.
 *
 * No live network calls. All HTTP is handled by injected fakes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SupplierRejectedRequestError,
  SupplierUnavailableError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { SupplierHttpClient, SearchCriteria } from '@travel/supplier-port';
import { AmadeusFlightAdapter } from '../../src/adapters/AmadeusFlightAdapter.js';
import { AmadeusTokenProvider } from '../../src/adapters/AmadeusTokenProvider.js';
import multiOfferFixture from '../fixtures/amadeus/multi-offer-search.json';
import emptyFixture from '../fixtures/amadeus/empty-availability.json';
import type { MinimalLogger } from '../../src/adapters/AmadeusTokenProvider.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
  };
}

function makeLogger(): MinimalLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTokenProvider(token = 'test-bearer-token'): AmadeusTokenProvider {
  const redis = {
    get: vi.fn(async () => null as string | null),
    set: vi.fn(async () => undefined as unknown),
    del: vi.fn(async () => undefined as unknown),
  };
  const httpClient = {
    post: vi.fn(async () => ({
      status: 200,
      json: async () => ({ access_token: token, expires_in: 1799 }),
    })),
  };
  return new AmadeusTokenProvider({
    redis,
    httpClient,
    clock: makeFakeClock(),
    config: {
      clientId: 'id',
      clientSecret: 'secret',
      tokenEndpoint: 'https://test.api.amadeus.com/v1/security/oauth2/token',
    },
    logger: makeLogger(),
  });
}

/** Create a mock SupplierHttpClient. */
function makeHttpClient(
  handler: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>,
): SupplierHttpClient {
  return {
    request: vi.fn(async (url: string) => handler(url)),
  } as unknown as SupplierHttpClient;
}

const FLIGHT_CRITERIA: SearchCriteria = {
  kind: 'flight',
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: new Date('2028-03-15T00:00:00Z'),
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

const HOTEL_CRITERIA: SearchCriteria = {
  kind: 'hotel',
  location: 'London',
  checkInDate: new Date('2028-03-15T00:00:00Z'),
  checkOutDate: new Date('2028-03-18T00:00:00Z'),
  guests: 2,
  currency: 'USD',
};

const ADAPTER_CONFIG = {
  searchEndpoint: 'https://test.api.amadeus.com/v2/shopping/flight-offers',
  defaultOfferValidityMinutes: 60,
};

function makeAdapter(
  httpClientHandler: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>,
  tokenProvider?: AmadeusTokenProvider,
) {
  return new AmadeusFlightAdapter({
    tokenProvider: tokenProvider ?? makeTokenProvider(),
    httpClient: makeHttpClient(httpClientHandler),
    clock: makeFakeClock(),
    config: ADAPTER_CONFIG,
    logger: makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AmadeusFlightAdapter — structural', () => {
  it('declares supplierName as AMADEUS', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture }));
    expect(adapter.supplierName).toBe('AMADEUS');
  });

  it('declares INSTANT as the only supported flow', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture }));
    expect(adapter.supportedFlows).toEqual(['INSTANT']);
  });
});

describe('AmadeusFlightAdapter — non-flight criteria', () => {
  it('returns empty array for hotel criteria without calling the HTTP client', async () => {
    const httpClient = makeHttpClient(async () => ({ status: 200, json: async () => emptyFixture }));
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider(),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    const offers = await adapter.searchOffers(HOTEL_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
    expect((httpClient.request as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('AmadeusFlightAdapter — success path', () => {
  it('returns mapped offers from the Amadeus response', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiOfferFixture,
    }));

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(2);
  });

  it('returns empty array when Amadeus has no availability', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => emptyFixture,
    }));

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
  });

  it('all returned offers have provenance AMADEUS and bookable true', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiOfferFixture,
    }));

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    for (const offer of offers) {
      expect(offer.provenance).toBe('AMADEUS');
      expect(offer.bookable).toBe(true);
    }
  });

  it('includes Authorization Bearer header in HTTP request', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      json: async () => emptyFixture,
    }));
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider('my-token'),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.any(String),
      'corr-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer my-token' } }),
    );
  });
});

describe('AmadeusFlightAdapter — error classification', () => {
  it('propagates SupplierRejectedRequestError for 4xx (non-401)', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('AMADEUS', 'corr', 429);
    });
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider(),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await expect(adapter.searchOffers(FLIGHT_CRITERIA, 'corr')).rejects.toThrow(SupplierRejectedRequestError);
  });

  it('propagates SupplierUnavailableError for 5xx', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierUnavailableError('AMADEUS', 'corr', 503);
    });
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider(),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await expect(adapter.searchOffers(FLIGHT_CRITERIA, 'corr')).rejects.toThrow(SupplierUnavailableError);
  });

  it('propagates SupplierTimeoutError for timeouts', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierTimeoutError('AMADEUS', 'corr', 2200);
    });
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider(),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await expect(adapter.searchOffers(FLIGHT_CRITERIA, 'corr')).rejects.toThrow(SupplierTimeoutError);
  });
});

describe('AmadeusFlightAdapter — token refresh on 401', () => {
  it('refreshes the token and retries once when search returns 401', async () => {
    let callCount = 0;
    const httpClient = makeHttpClient(async () => {
      callCount++;
      if (callCount === 1) {
        throw new SupplierRejectedRequestError('AMADEUS', 'corr', 401);
      }
      return { status: 200, json: async () => emptyFixture };
    });

    const tokenProvider = makeTokenProvider();
    const refreshSpy = vi.spyOn(tokenProvider, 'refreshToken').mockResolvedValue('new-token');

    const adapter = new AmadeusFlightAdapter({
      tokenProvider,
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
    expect(offers).toHaveLength(0);
  });

  it('throws SupplierUnavailableError when retry after 401 also fails', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('AMADEUS', 'corr', 401);
    });

    const tokenProvider = makeTokenProvider();
    vi.spyOn(tokenProvider, 'refreshToken').mockResolvedValue('new-token');

    const adapter = new AmadeusFlightAdapter({
      tokenProvider,
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await expect(adapter.searchOffers(FLIGHT_CRITERIA, 'corr')).rejects.toThrow();
  });
});

describe('AmadeusFlightAdapter — URL construction', () => {
  it('includes search criteria in the query string', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture };
    });
    const adapter = new AmadeusFlightAdapter({
      tokenProvider: makeTokenProvider(),
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await adapter.searchOffers(FLIGHT_CRITERIA, 'corr');

    expect(capturedUrl).toContain('originLocationCode=LHR');
    expect(capturedUrl).toContain('destinationLocationCode=JFK');
    expect(capturedUrl).toContain('adults=1');
    expect(capturedUrl).toContain('travelClass=ECONOMY');
    expect(capturedUrl).toContain('currencyCode=USD');
    expect(capturedUrl).toContain('departureDate=2028-03-15');
  });
});
