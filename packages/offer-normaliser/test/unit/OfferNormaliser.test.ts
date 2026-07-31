import { OfferNormaliser } from '../../src/OfferNormaliser.js';

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
// Fixtures
// ---------------------------------------------------------------------------

import flightFixtures from '../fixtures/flights/multi-supplier-offers.json';
import hotelFixtures from '../fixtures/hotels/multi-supplier-offers.json';
import carFixtures from '../fixtures/cars/multi-supplier-offers.json';

// Clock that makes future-dated fixtures non-expired and past-dated expired
const FIXED_CLOCK_MS = new Date('2026-01-01T00:00:00Z').getTime();
const FIXED_CLOCK = { now: () => FIXED_CLOCK_MS };

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeNormaliser(
  opts: {
    category?: string;
    clock?: { now(): number };
    logger?: ReturnType<typeof makeLogger>;
  } = {},
) {
  return new OfferNormaliser({
    config: { category: opts.category ?? 'flight' },
    logger: opts.logger ?? makeLogger(),
    clock: opts.clock ?? FIXED_CLOCK,
  });
}

// ---------------------------------------------------------------------------
// Valid offer shape helper
// ---------------------------------------------------------------------------

function validFlightOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-flight-001',
    provenance: 'AMADEUS',
    bookable: true,
    title: 'Test Flight',
    price: 299.99,
    currency: 'USD',
    details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY' },
    expiresAt: '2028-12-31T23:59:59Z',
    freshness: 'FRESH',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Normalisation from flight fixture
// ---------------------------------------------------------------------------

describe('OfferNormaliser — flight fixture normalisation', () => {
  it('normalises all valid non-expired flight offers from fixture', () => {
    const normaliser = makeNormaliser({ category: 'flight' });
    const result = normaliser.normalise(flightFixtures);

    // Fixture has 7 entries: 5 valid+non-expired, 1 expired, 1 invalid
    expect(result.length).toBe(5);
  });

  it('every output offer validates against OfferSchema (provenance, bookable, price, currency)', () => {
    const normaliser = makeNormaliser({ category: 'flight' });
    const result = normaliser.normalise(flightFixtures);
    for (const offer of result) {
      expect(offer.id).toBeTruthy();
      expect(['AMADEUS', 'RAPIDAPI', 'ILLUSTRATIVE']).toContain(offer.provenance);
      expect(typeof offer.bookable).toBe('boolean');
      expect(typeof offer.price).toBe('number');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.currency).toBe('USD');
      expect(offer.expiresAt).toBeInstanceOf(Date);
      expect(['FRESH', 'STALE']).toContain(offer.freshness);
    }
  });

  it('includes illustrative offer in output', () => {
    const normaliser = makeNormaliser({ category: 'flight' });
    const result = normaliser.normalise(flightFixtures);
    const illustrative = result.filter((o) => o.provenance === 'ILLUSTRATIVE');
    expect(illustrative.length).toBe(1);
    expect(illustrative[0]!.bookable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hotel fixture normalisation
// ---------------------------------------------------------------------------

describe('OfferNormaliser — hotel fixture normalisation', () => {
  it('normalises all valid hotel offers', () => {
    const normaliser = makeNormaliser({ category: 'hotel' });
    const result = normaliser.normalise(hotelFixtures);
    expect(result.length).toBe(5);
  });

  it('hotel offers with rating field have number rating', () => {
    const normaliser = makeNormaliser({ category: 'hotel' });
    const result = normaliser.normalise(hotelFixtures);
    const withRating = result.filter((o) => o.rating !== undefined);
    expect(withRating.length).toBeGreaterThan(0);
    for (const offer of withRating) {
      expect(typeof offer.rating).toBe('number');
      expect(offer.rating!).toBeGreaterThanOrEqual(0);
      expect(offer.rating!).toBeLessThanOrEqual(5);
    }
  });

  it('hotel offer without rating is not penalised — field simply absent', () => {
    const normaliser = makeNormaliser({ category: 'hotel' });
    const result = normaliser.normalise(hotelFixtures);
    const noRating = result.find((o) => o.id === 'rapidapi-hotel-no-rating');
    expect(noRating).toBeDefined();
    expect(noRating!.rating).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Car fixture normalisation
// ---------------------------------------------------------------------------

describe('OfferNormaliser — car fixture normalisation', () => {
  it('normalises all valid car offers', () => {
    const normaliser = makeNormaliser({ category: 'car' });
    const result = normaliser.normalise(carFixtures);
    expect(result.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Validation failure handling
// ---------------------------------------------------------------------------

describe('OfferNormaliser — validation failure', () => {
  it('drops offer with missing required title field and logs a warning', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    const invalidOffer = validFlightOffer({ title: undefined });

    const result = normaliser.normalise([invalidOffer]);
    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'offer.normalisation_failed',
        offerId: 'test-flight-001',
        supplier: 'AMADEUS',
      }),
      expect.any(String),
    );
  });

  it('drops offer with negative price and logs a warning', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    const invalidOffer = validFlightOffer({ price: -10 });

    const result = normaliser.normalise([invalidOffer]);
    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'offer.normalisation_failed' }),
      expect.any(String),
    );
  });

  it('drops offer with invalid provenance', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    const invalidOffer = validFlightOffer({ provenance: 'UNKNOWN_SUPPLIER' });

    const result = normaliser.normalise([invalidOffer]);
    expect(result).toHaveLength(0);
  });

  it('drops ILLUSTRATIVE offer that is also bookable=true', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    // ILLUSTRATIVE + bookable=true is structurally invalid per OfferSchema.superRefine
    const invalidOffer = validFlightOffer({ provenance: 'ILLUSTRATIVE', bookable: true });

    const result = normaliser.normalise([invalidOffer]);
    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('continues processing remaining offers after a failure', () => {
    const normaliser = makeNormaliser();
    const offers = [
      validFlightOffer({ id: 'bad', title: undefined }),
      validFlightOffer({ id: 'good' }),
    ];
    const result = normaliser.normalise(offers);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// Expiry exclusion
// ---------------------------------------------------------------------------

describe('OfferNormaliser — expiry exclusion', () => {
  it('excludes expired offer and emits counter', () => {
    counterAdd.mockClear();
    const normaliser = makeNormaliser({ category: 'flight' });
    const expiredOffer = validFlightOffer({
      id: 'expired-offer',
      expiresAt: '2020-01-01T00:00:00Z',
      freshness: 'STALE',
    });

    const result = normaliser.normalise([expiredOffer]);
    expect(result).toHaveLength(0);
    expect(counterAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ category: 'flight', supplier: 'AMADEUS' }),
    );
  });

  it('logs expired offer with reason', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    const expiredOffer = validFlightOffer({ expiresAt: '2020-06-01T00:00:00Z', freshness: 'STALE' });

    normaliser.normalise([expiredOffer]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'offer.expired',
        offerId: 'test-flight-001',
        supplier: 'AMADEUS',
      }),
      expect.any(String),
    );
  });

  it('offer exactly at clock time is treated as expired (boundary condition)', () => {
    const clockMs = new Date('2027-06-01T12:00:00Z').getTime();
    const normaliser = makeNormaliser({ clock: { now: () => clockMs } });
    const boundaryOffer = validFlightOffer({ expiresAt: '2027-06-01T12:00:00Z' });

    const result = normaliser.normalise([boundaryOffer]);
    expect(result).toHaveLength(0);
  });

  it('offer one millisecond after clock is not expired', () => {
    const clockMs = new Date('2027-06-01T12:00:00Z').getTime() - 1;
    const normaliser = makeNormaliser({ clock: { now: () => clockMs } });
    const notExpiredOffer = validFlightOffer({ expiresAt: '2027-06-01T12:00:00Z' });

    const result = normaliser.normalise([notExpiredOffer]);
    expect(result).toHaveLength(1);
  });

  it('all-expired input returns empty array', () => {
    const normaliser = makeNormaliser();
    const expired = [
      validFlightOffer({ id: 'e1', expiresAt: '2020-01-01T00:00:00Z', freshness: 'STALE' }),
      validFlightOffer({ id: 'e2', expiresAt: '2021-01-01T00:00:00Z', freshness: 'STALE' }),
    ];
    const result = normaliser.normalise(expired);
    expect(result).toHaveLength(0);
  });

  it('counter dimensions include category and supplier for each expired offer', () => {
    counterAdd.mockClear();
    const normaliser = makeNormaliser({ category: 'car' });
    const expiredCar = {
      id: 'expired-car',
      provenance: 'RAPIDAPI',
      bookable: true,
      title: 'Expired Car',
      price: 50,
      currency: 'USD',
      details: { supplier: 'RAPIDAPI' },
      expiresAt: '2020-01-01T00:00:00Z',
      freshness: 'STALE',
    };

    normaliser.normalise([expiredCar]);
    expect(counterAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ category: 'car', supplier: 'RAPIDAPI' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('OfferNormaliser — edge cases', () => {
  it('returns empty array for empty input', () => {
    const normaliser = makeNormaliser();
    expect(normaliser.normalise([])).toHaveLength(0);
  });

  it('handles null/undefined in input array by dropping with warning', () => {
    const logger = makeLogger();
    const normaliser = makeNormaliser({ logger });
    const result = normaliser.normalise([null, undefined, validFlightOffer()]);
    expect(result).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
