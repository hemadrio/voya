/**
 * Unit tests for RapidApiHotelAdapter.
 *
 * Tests: non-hotel criteria passthrough, success path, error classification,
 * 429 → SupplierUnavailableError with SUPPLIER_QUOTA_EXHAUSTED log code,
 * API key never logged, URL construction.
 *
 * No live network calls. All HTTP handled by injected fakes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SupplierRejectedRequestError,
  SupplierUnavailableError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { SupplierHttpClient, SearchCriteria } from '@travel/supplier-port';
import { RapidApiHotelAdapter } from '../../src/adapters/RapidApiHotelAdapter.js';
import type { MinimalLogger, RapidApiAdapterConfig } from '../../src/adapters/RapidApiHotelAdapter.js';
import multiFixture from '../fixtures/rapidapi-hotel/multi-property-success.json';
import emptyFixture from '../fixtures/rapidapi-hotel/empty-results.json';

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

function makeHttpClient(
  handler: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>,
): SupplierHttpClient {
  return {
    request: vi.fn(async (url: string) => handler(url)),
  } as unknown as SupplierHttpClient;
}

const ADAPTER_CONFIG: RapidApiAdapterConfig = {
  searchEndpoint: 'https://test-hotels.p.rapidapi.com/hotels/search',
  apiHost: 'test-hotels.p.rapidapi.com',
  apiKey: 'SANITISED_API_KEY_DO_NOT_USE_IN_LIVE_CALLS',
  defaultOfferValidityMinutes: 30,
};

const HOTEL_CRITERIA: SearchCriteria = {
  kind: 'hotel',
  location: 'New York',
  checkInDate: new Date('2028-03-15T00:00:00Z'),
  checkOutDate: new Date('2028-03-18T00:00:00Z'),
  guests: 2,
  currency: 'USD',
};

const FLIGHT_CRITERIA: SearchCriteria = {
  kind: 'flight',
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: new Date('2028-03-15T00:00:00Z'),
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

function makeAdapter(
  handler: (url: string) => Promise<{ status: number; json: <T>() => Promise<T> }>,
  logger?: MinimalLogger,
) {
  return new RapidApiHotelAdapter({
    httpClient: makeHttpClient(handler),
    clock: makeFakeClock(),
    config: ADAPTER_CONFIG,
    logger: logger ?? makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — structural', () => {
  it('declares supplierName as RAPIDAPI', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture }));
    expect(adapter.supplierName).toBe('RAPIDAPI');
  });

  it('declares INSTANT as the only supported flow', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture }));
    expect(adapter.supportedFlows).toEqual(['INSTANT']);
  });

  it('does NOT implement reserve or confirm', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture }));
    expect((adapter as unknown as Record<string, unknown>)['reserve']).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>)['confirm']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-hotel criteria passthrough
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — non-hotel criteria', () => {
  it('returns empty array for flight criteria without HTTP call', async () => {
    const httpClient = makeHttpClient(async () => ({ status: 200, json: async () => emptyFixture }));
    const adapter = new RapidApiHotelAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
    expect((httpClient.request as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — success path', () => {
  it('returns mapped offers from the provider response', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiFixture as unknown,
    }));

    const offers = await adapter.searchOffers(HOTEL_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(2);
  });

  it('returns empty array when provider has no results', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => emptyFixture as unknown,
    }));

    const offers = await adapter.searchOffers(HOTEL_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
  });

  it('all offers have provenance RAPIDAPI and bookable true', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiFixture as unknown,
    }));

    const offers = await adapter.searchOffers(HOTEL_CRITERIA, 'corr-1');
    for (const offer of offers) {
      expect(offer.provenance).toBe('RAPIDAPI');
      expect(offer.bookable).toBe(true);
    }
  });

  it('sends x-rapidapi-key and x-rapidapi-host headers', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      json: async () => emptyFixture as unknown,
    }));
    const adapter = new RapidApiHotelAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await adapter.searchOffers(HOTEL_CRITERIA, 'corr-1');
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.any(String),
      'corr-1',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-rapidapi-key': ADAPTER_CONFIG.apiKey,
          'x-rapidapi-host': ADAPTER_CONFIG.apiHost,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — error classification', () => {
  it('propagates SupplierRejectedRequestError for non-429 4xx', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 400);
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(HOTEL_CRITERIA, 'corr')).rejects.toThrow(SupplierRejectedRequestError);
  });

  it('remaps 429 to SupplierUnavailableError with SUPPLIER_QUOTA_EXHAUSTED log code', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 429);
    });
    const logger = makeLogger();
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger,
    });

    await expect(adapter.searchOffers(HOTEL_CRITERIA, 'corr')).rejects.toThrow(SupplierUnavailableError);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ logCode: 'SUPPLIER_QUOTA_EXHAUSTED', alertable: true }),
      expect.any(String),
    );
  });

  it('propagates SupplierUnavailableError for 5xx', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierUnavailableError('RAPIDAPI', 'corr', 503);
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(HOTEL_CRITERIA, 'corr')).rejects.toThrow(SupplierUnavailableError);
  });

  it('propagates SupplierTimeoutError for timeouts', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierTimeoutError('RAPIDAPI', 'corr', 2200);
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(HOTEL_CRITERIA, 'corr')).rejects.toThrow(SupplierTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// API key security — never logged
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — API key security', () => {
  it('never logs the API key value', async () => {
    const secretKey = 'SUPER_SECRET_RAPIDAPI_KEY_12345';
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 401);
    });
    const logger = makeLogger();
    const adapter = new RapidApiHotelAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: { ...ADAPTER_CONFIG, apiKey: secretKey },
      logger,
    });

    await expect(adapter.searchOffers(HOTEL_CRITERIA, 'corr')).rejects.toThrow();

    const allLogCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const loggedText = JSON.stringify(allLogCalls);
    expect(loggedText).not.toContain(secretKey);
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('RapidApiHotelAdapter — URL construction', () => {
  it('includes search criteria in the query string', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture as unknown };
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await adapter.searchOffers(HOTEL_CRITERIA, 'corr');

    expect(capturedUrl).toContain('location=New+York');
    expect(capturedUrl).toContain('checkIn=2028-03-15');
    expect(capturedUrl).toContain('checkOut=2028-03-18');
    expect(capturedUrl).toContain('adults=2');
    expect(capturedUrl).toContain('currency=USD');
  });

  it('appends starRating param when criteria includes star rating filter', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture as unknown };
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    const criteriaWithStar: SearchCriteria = {
      kind: 'hotel',
      location: 'New York',
      checkInDate: new Date('2028-03-15T00:00:00Z'),
      checkOutDate: new Date('2028-03-18T00:00:00Z'),
      guests: 2,
      currency: 'USD',
      starRating: 4,
    };

    await adapter.searchOffers(criteriaWithStar, 'corr');
    expect(capturedUrl).toContain('starRating=4');
  });

  it('does not include starRating param when filter is absent', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture as unknown };
    });
    const adapter = new RapidApiHotelAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await adapter.searchOffers(HOTEL_CRITERIA, 'corr'); // no starRating
    expect(capturedUrl).not.toContain('starRating');
  });
});
