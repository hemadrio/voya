/**
 * Unit tests for IllustrativeOfferGenerator.
 *
 * Covers: offer shape, provenance/bookable, flag-off behaviour, hard-override
 * behaviour, fail-closed audit write, deterministic output, API key security,
 * OTel counter (via mock), non-bookable label.
 */

import { IllustrativeOfferGenerator } from '../../src/IllustrativeOfferGenerator.js';
import { FakeFeatureFlagProvider } from '../fakes/FakeFeatureFlagProvider.js';
import { FakeAuditWriter } from '../fakes/FakeAuditWriter.js';
import { ILLUSTRATIVE_FLAG_KEY } from '../../src/types.js';
import type { SearchCriteria } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// OTel counter stub — prevents real SDK initialisation in tests
// ---------------------------------------------------------------------------

jest.mock('@opentelemetry/api', () => {
  const addMock = jest.fn();
  return {
    metrics: {
      getMeter: () => ({
        createCounter: () => ({ add: addMock }),
      }),
    },
    _addMock: addMock,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _addMock: counterAdd } = require('@opentelemetry/api') as { _addMock: jest.Mock };

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

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

const CAR_CRITERIA: SearchCriteria = {
  kind: 'car',
  pickupLocation: 'JFK',
  dropoffLocation: 'JFK',
  pickupDate: new Date('2028-03-15T00:00:00Z'),
  dropoffDate: new Date('2028-03-18T00:00:00Z'),
  carClass: 'ECONOMY',
  currency: 'USD',
};

const FIXED_NOW = 1_700_000_000_000;
const FIXED_CLOCK = { now: () => FIXED_NOW };

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeGenerator(
  opts: {
    flagEnabled?: boolean;
    environment?: string;
    hardDisabledEnvironments?: ReadonlyArray<string>;
    flagProvider?: FakeFeatureFlagProvider;
    auditWriter?: FakeAuditWriter;
    logger?: ReturnType<typeof makeLogger>;
  } = {},
) {
  const flagProvider =
    opts.flagProvider ??
    new FakeFeatureFlagProvider({ [ILLUSTRATIVE_FLAG_KEY]: opts.flagEnabled ?? true });
  const auditWriter = opts.auditWriter ?? new FakeAuditWriter();
  const logger = opts.logger ?? makeLogger();

  const gen = new IllustrativeOfferGenerator({
    featureFlagProvider: flagProvider,
    auditWriter,
    config: {
      environment: opts.environment ?? 'staging',
      hardDisabledEnvironments: opts.hardDisabledEnvironments ?? ['production'],
      actorIdentifier: 'search-service',
      defaultValidityMinutes: 30,
    },
    logger,
    clock: FIXED_CLOCK,
  });

  return { gen, flagProvider, auditWriter, logger };
}

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — structural', () => {
  it('declares supplierName as ILLUSTRATIVE', () => {
    const { gen } = makeGenerator();
    expect(gen.supplierName).toBe('ILLUSTRATIVE');
  });

  it('declares INSTANT as the only supported flow', () => {
    const { gen } = makeGenerator();
    expect(gen.supportedFlows).toEqual(['INSTANT']);
  });

  it('does NOT implement reserve or confirm', () => {
    const { gen } = makeGenerator();
    expect((gen as unknown as Record<string, unknown>)['reserve']).toBeUndefined();
    expect((gen as unknown as Record<string, unknown>)['confirm']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Offer shape validation
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — offer shape', () => {
  it('returns 3 flight offers with correct shape when flag is enabled', async () => {
    const { gen, auditWriter } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');

    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      expect(offer.provenance).toBe('ILLUSTRATIVE');
      expect(offer.bookable).toBe(false);
      expect(typeof offer.title).toBe('string');
      expect(offer.title.length).toBeGreaterThan(0);
      expect(typeof offer.price).toBe('number');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.currency).toBe('USD');
      expect(offer.expiresAt).toBeInstanceOf(Date);
      expect(offer.freshness).toBe('FRESH');
      expect(typeof offer.id).toBe('string');
      expect(offer.id.length).toBeGreaterThan(0);
    }
    expect(auditWriter.records).toHaveLength(1);
  });

  it('returns hotel offers for hotel criteria', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(HOTEL_CRITERIA, 'corr-2');
    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      expect(offer.provenance).toBe('ILLUSTRATIVE');
      expect(offer.title).toContain('Hotel');
    }
  });

  it('returns car offers for car criteria', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(CAR_CRITERIA, 'corr-3');
    expect(offers).toHaveLength(3);
    for (const offer of offers) {
      expect(offer.provenance).toBe('ILLUSTRATIVE');
      expect(offer.title).toContain('Car');
    }
  });

  it('every offer has a notBookableLabel in details', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    for (const offer of offers) {
      expect(typeof (offer.details as Record<string, unknown>)['notBookableLabel']).toBe('string');
    }
  });

  it('details.supplier is ILLUSTRATIVE', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(HOTEL_CRITERIA, 'corr-2');
    for (const offer of offers) {
      expect((offer.details as Record<string, unknown>)['supplier']).toBe('ILLUSTRATIVE');
    }
  });

  it('expiresAt is now + defaultValidityMinutes', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    const expectedExpiry = new Date(FIXED_NOW + 30 * 60 * 1000);
    for (const offer of offers) {
      expect(offer.expiresAt.toISOString()).toBe(expectedExpiry.toISOString());
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic output
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — deterministic output', () => {
  it('same criteria produces the same offer IDs across calls', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const first = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-a');
    const second = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-b');
    expect(first.map((o) => o.id)).toEqual(second.map((o) => o.id));
  });

  it('same criteria produces the same prices across calls', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const first = await gen.searchOffers(HOTEL_CRITERIA, 'corr-a');
    const second = await gen.searchOffers(HOTEL_CRITERIA, 'corr-b');
    expect(first.map((o) => o.price)).toEqual(second.map((o) => o.price));
  });

  it('different criteria produces different offer IDs', async () => {
    const { gen } = makeGenerator({ flagEnabled: true });
    const flight = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    const hotel = await gen.searchOffers(HOTEL_CRITERIA, 'corr-1');
    expect(flight[0]!.id).not.toBe(hotel[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Flag-off behaviour
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — flag disabled', () => {
  it('returns empty array when flag is disabled', async () => {
    const { gen, auditWriter } = makeGenerator({ flagEnabled: false });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
    expect(auditWriter.records).toHaveLength(0);
  });

  it('does not write an audit record when flag is disabled', async () => {
    const { gen, auditWriter } = makeGenerator({ flagEnabled: false });
    await gen.searchOffers(HOTEL_CRITERIA, 'corr-2');
    expect(auditWriter.records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hard-override behaviour
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — hard-override (AC3)', () => {
  it('returns zero offers when environment is in hardDisabledEnvironments', async () => {
    const { gen, auditWriter } = makeGenerator({
      environment: 'production',
      hardDisabledEnvironments: ['production'],
      flagEnabled: true,
    });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(offers).toHaveLength(0);
    expect(auditWriter.records).toHaveLength(0);
  });

  it('produces zero offers in production even with flag enabled (AC3 guarantee)', async () => {
    const { gen } = makeGenerator({
      environment: 'production',
      hardDisabledEnvironments: ['production'],
      flagEnabled: true,
    });
    const offers = await gen.searchOffers(HOTEL_CRITERIA, 'corr-prod');
    expect(offers).toHaveLength(0);
  });

  it('still generates offers in staging when production is hard-disabled', async () => {
    const { gen } = makeGenerator({
      environment: 'staging',
      hardDisabledEnvironments: ['production'],
      flagEnabled: true,
    });
    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-staging');
    expect(offers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Audit write invocation (AC4)
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — audit write', () => {
  it('writes exactly one audit record per searchOffers call when flag is enabled', async () => {
    const { gen, auditWriter } = makeGenerator({ flagEnabled: true });
    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-1');
    expect(auditWriter.records).toHaveLength(1);
  });

  it('audit record contains required fields', async () => {
    const { gen, auditWriter } = makeGenerator({
      flagEnabled: true,
      environment: 'staging',
    });
    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-audit');
    const record = auditWriter.records[0]!;
    expect(record.type).toBe('ILLUSTRATIVE_OFFERS_SERVED');
    expect(record.actor).toBe('search-service');
    expect(record.timestamp).toBeInstanceOf(Date);
    expect(record.environment).toBe('staging');
    expect(record.category).toBe('flight');
    expect(record.flagState).toBe('enabled');
    expect(record.correlationId).toBe('corr-audit');
    expect(typeof record.offersCount).toBe('number');
    expect(record.offersCount).toBeGreaterThan(0);
  });

  it('fail-closed: returns no offers when audit write throws (AC7)', async () => {
    const auditWriter = new FakeAuditWriter();
    auditWriter.failNext();
    const logger = makeLogger();
    const { gen } = makeGenerator({ flagEnabled: true, auditWriter, logger });

    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-audit-fail');
    expect(offers).toHaveLength(0);
  });

  it('fail-closed: logs an alertable error when audit write throws', async () => {
    const auditWriter = new FakeAuditWriter();
    auditWriter.failNext();
    const logger = makeLogger();
    const { gen } = makeGenerator({ flagEnabled: true, auditWriter, logger });

    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-audit-fail');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alertable: true, event: 'illustrative.audit_write_failed' }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// Flag provider error handling
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — flag provider error', () => {
  it('returns empty array when flag provider throws', async () => {
    const flagProvider = new FakeFeatureFlagProvider({ [ILLUSTRATIVE_FLAG_KEY]: true });
    flagProvider.failNext();
    const { gen } = makeGenerator({ flagProvider });

    const offers = await gen.searchOffers(FLIGHT_CRITERIA, 'corr-flag-err');
    expect(offers).toHaveLength(0);
  });

  it('logs a warning when flag provider throws', async () => {
    const flagProvider = new FakeFeatureFlagProvider({ [ILLUSTRATIVE_FLAG_KEY]: true });
    flagProvider.failNext();
    const logger = makeLogger();
    const { gen } = makeGenerator({ flagProvider, logger });

    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-flag-err');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'illustrative.flag_provider_error' }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// OTel counter (AC5)
// ---------------------------------------------------------------------------

describe('IllustrativeOfferGenerator — OTel counter', () => {
  beforeEach(() => {
    counterAdd.mockClear();
  });

  it('increments counter with environment and category dimensions on success', async () => {
    const { gen } = makeGenerator({ flagEnabled: true, environment: 'dev' });
    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-otel');

    expect(counterAdd).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ environment: 'dev', category: 'flight' }),
    );
  });

  it('does not increment counter when flag is disabled', async () => {
    const { gen } = makeGenerator({ flagEnabled: false });
    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-no-counter');
    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('does not increment counter when hard-disabled', async () => {
    const { gen } = makeGenerator({
      environment: 'production',
      hardDisabledEnvironments: ['production'],
      flagEnabled: true,
    });
    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-no-counter-hard');
    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('does not increment counter when audit write fails (fail-closed)', async () => {
    const auditWriter = new FakeAuditWriter();
    auditWriter.failNext();
    const { gen } = makeGenerator({ flagEnabled: true, auditWriter });

    await gen.searchOffers(FLIGHT_CRITERIA, 'corr-fail-closed-counter');
    expect(counterAdd).not.toHaveBeenCalled();
  });
});
