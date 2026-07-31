/**
 * Unit tests for RapidApiCarAdapter.
 *
 * Tests: non-car criteria passthrough (no HTTP call), success path, error
 * classification, API key never logged, URL construction, unmappedClassCount
 * warn logging.
 *
 * No live network calls. All HTTP handled by injected fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SupplierRejectedRequestError,
  SupplierUnavailableError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { SupplierHttpClient, SearchCriteria } from '@travel/supplier-port';
import { RapidApiCarAdapter } from '../../src/adapters/RapidApiCarAdapter.js';
import type { MinimalLogger, RapidApiCarAdapterConfig } from '../../src/adapters/RapidApiCarAdapter.js';
import multiFixture from '../fixtures/rapidapi-car/multi-vehicle-success.json';
import unmappedFixture from '../fixtures/rapidapi-car/unmapped-class.json';
import emptyFixture from '../fixtures/rapidapi-car/empty-results.json';

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

const ADAPTER_CONFIG: RapidApiCarAdapterConfig = {
  searchEndpoint: 'https://test-cars.p.rapidapi.com/cars/search',
  apiHost: 'test-cars.p.rapidapi.com',
  apiKey: 'SANITISED_API_KEY_DO_NOT_USE_IN_LIVE_CALLS',
  defaultOfferValidityMinutes: 30,
};

const CAR_CRITERIA: SearchCriteria = {
  kind: 'car',
  pickupLocation: 'JFK',
  dropoffLocation: 'JFK',
  pickupDate: new Date('2028-03-15T00:00:00Z'),
  dropoffDate: new Date('2028-03-18T00:00:00Z'),
  carClass: 'ECONOMY',
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

const HOTEL_CRITERIA: SearchCriteria = {
  kind: 'hotel',
  location: 'New York',
  checkInDate: new Date('2028-03-15T00:00:00Z'),
  checkOutDate: new Date('2028-03-18T00:00:00Z'),
  guests: 2,
  currency: 'USD',
};

function makeAdapter(
  handler: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>,
  logger?: MinimalLogger,
) {
  return new RapidApiCarAdapter({
    httpClient: makeHttpClient(handler),
    clock: makeFakeClock(),
    config: ADAPTER_CONFIG,
    logger: logger ?? makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — structural', () => {
  it('declares supplierName as RAPIDAPI', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture as unknown }));
    expect(adapter.supplierName).toBe('RAPIDAPI');
  });

  it('declares INSTANT as the only supported flow', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture as unknown }));
    expect(adapter.supportedFlows).toEqual(['INSTANT']);
  });

  it('does NOT implement reserve or confirm', () => {
    const adapter = makeAdapter(async () => ({ status: 200, json: async () => emptyFixture as unknown }));
    expect((adapter as unknown as Record<string, unknown>)['reserve']).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>)['confirm']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-car criteria passthrough
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — non-car criteria', () => {
  it('returns empty array for flight criteria without HTTP call', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      json: async () => emptyFixture as unknown,
    }));
    const adapter = new RapidApiCarAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    const offers = await adapter.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
    expect((httpClient.request as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns empty array for hotel criteria without HTTP call', async () => {
    const httpClient = makeHttpClient(async () => ({
      status: 200,
      json: async () => emptyFixture as unknown,
    }));
    const adapter = new RapidApiCarAdapter({
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

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — success path', () => {
  it('returns mapped offers from the provider response', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiFixture as unknown,
    }));

    const offers = await adapter.searchOffers(CAR_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(3);
  });

  it('returns empty array when provider has no results', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => emptyFixture as unknown,
    }));

    const offers = await adapter.searchOffers(CAR_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
  });

  it('all offers have provenance RAPIDAPI and bookable true', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => multiFixture as unknown,
    }));

    const offers = await adapter.searchOffers(CAR_CRITERIA, 'corr-1');
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
    const adapter = new RapidApiCarAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger: makeLogger(),
    });

    await adapter.searchOffers(CAR_CRITERIA, 'corr-1');
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
// Unmapped vehicle class logging
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — unmapped vehicle class', () => {
  it('logs a warn for each unmapped vehicle description', async () => {
    const logger = makeLogger();
    const adapter = new RapidApiCarAdapter({
      httpClient: makeHttpClient(async () => ({
        status: 200,
        json: async () => unmappedFixture as unknown,
      })),
      clock: makeFakeClock(),
      config: ADAPTER_CONFIG,
      logger,
    });

    await adapter.searchOffers(CAR_CRITERIA, 'corr-1');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'rapidapi.car.unmapped_vehicle_class',
        rawDescription: 'Motorsport Cabriolet Turbo',
      }),
      expect.any(String),
    );
  });

  it('still returns the offer even when vehicle class is UNKNOWN', async () => {
    const adapter = makeAdapter(async () => ({
      status: 200,
      json: async () => unmappedFixture as unknown,
    }));

    const offers = await adapter.searchOffers(CAR_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(1);
    expect((offers[0]!.details as Record<string, unknown>)['vehicleClass']).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Error classification — 4xx is SupplierRejectedRequestError (no 429 remap)
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — error classification', () => {
  it('propagates SupplierRejectedRequestError for 400', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 400);
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(CAR_CRITERIA, 'corr')).rejects.toThrow(SupplierRejectedRequestError);
  });

  it('propagates SupplierRejectedRequestError for 429 (no remap unlike hotel adapter)', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 429);
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(CAR_CRITERIA, 'corr')).rejects.toThrow(SupplierRejectedRequestError);
  });

  it('propagates SupplierUnavailableError for 5xx', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierUnavailableError('RAPIDAPI', 'corr', 503);
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(CAR_CRITERIA, 'corr')).rejects.toThrow(SupplierUnavailableError);
  });

  it('propagates SupplierTimeoutError for timeouts', async () => {
    const httpClient = makeHttpClient(async () => {
      throw new SupplierTimeoutError('RAPIDAPI', 'corr', 2200);
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await expect(adapter.searchOffers(CAR_CRITERIA, 'corr')).rejects.toThrow(SupplierTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// API key security — never logged
// ---------------------------------------------------------------------------

describe('RapidApiCarAdapter — API key security', () => {
  it('never logs the API key value', async () => {
    const secretKey = 'SUPER_SECRET_RAPIDAPI_KEY_99999';
    const httpClient = makeHttpClient(async () => {
      throw new SupplierRejectedRequestError('RAPIDAPI', 'corr', 401);
    });
    const logger = makeLogger();
    const adapter = new RapidApiCarAdapter({
      httpClient,
      clock: makeFakeClock(),
      config: { ...ADAPTER_CONFIG, apiKey: secretKey },
      logger,
    });

    await expect(adapter.searchOffers(CAR_CRITERIA, 'corr')).rejects.toThrow();

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

describe('RapidApiCarAdapter — URL construction', () => {
  it('includes search criteria in the query string', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture as unknown };
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await adapter.searchOffers(CAR_CRITERIA, 'corr');

    expect(capturedUrl).toContain('pickupLocation=JFK');
    expect(capturedUrl).toContain('dropoffLocation=JFK');
    expect(capturedUrl).toContain('pickupDate=2028-03-15');
    expect(capturedUrl).toContain('dropoffDate=2028-03-18');
    expect(capturedUrl).toContain('carClass=ECONOMY');
    expect(capturedUrl).toContain('currency=USD');
  });

  it('uses the configured search endpoint as the base URL', async () => {
    let capturedUrl = '';
    const httpClient = makeHttpClient(async (url) => {
      capturedUrl = url;
      return { status: 200, json: async () => emptyFixture as unknown };
    });
    const adapter = new RapidApiCarAdapter({
      httpClient, clock: makeFakeClock(), config: ADAPTER_CONFIG, logger: makeLogger(),
    });

    await adapter.searchOffers(CAR_CRITERIA, 'corr');
    expect(capturedUrl).toContain('test-cars.p.rapidapi.com/cars/search');
  });
});
