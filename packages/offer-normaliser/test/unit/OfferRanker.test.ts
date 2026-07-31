import { OfferRanker } from '../../src/OfferRanker.js';
import { DEFAULT_RANKING_WEIGHTS, validateWeights } from '../../src/rankingWeights.js';
import type { Offer } from '@travel/contracts';
import type { MemberPreferences, RankerConfig } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<RankerConfig> = {}): RankerConfig {
  return {
    weights: DEFAULT_RANKING_WEIGHTS,
    exposeRankingExplanation: false,
    ...overrides,
  };
}

function makeRanker(overrides: Partial<RankerConfig> = {}): OfferRanker {
  return new OfferRanker({ config: makeConfig(overrides) });
}

function flightOffer(overrides: Partial<Offer> & { id: string }): Offer {
  return {
    id: overrides.id,
    provenance: 'AMADEUS',
    bookable: true,
    title: `Flight ${overrides.id}`,
    price: 300,
    currency: 'USD',
    details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' },
    expiresAt: new Date('2028-12-31T23:59:59Z'),
    freshness: 'FRESH',
    ...overrides,
  } as Offer;
}

function illustrativeOffer(overrides: Partial<Offer> & { id: string }): Offer {
  return {
    id: overrides.id,
    provenance: 'ILLUSTRATIVE',
    bookable: false,
    title: `Illustrative ${overrides.id}`,
    price: 50,
    currency: 'USD',
    details: { supplier: 'ILLUSTRATIVE', cabinClass: 'ECONOMY' },
    expiresAt: new Date('2028-12-31T23:59:59Z'),
    freshness: 'FRESH',
    ...overrides,
  } as Offer;
}

const NO_PREFS: MemberPreferences = {};

// ---------------------------------------------------------------------------
// Bookable-before-non-bookable (AC5)
// ---------------------------------------------------------------------------

describe('OfferRanker — illustrative demotion (AC5)', () => {
  it('places bookable offers before non-bookable regardless of price', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      illustrativeOffer({ id: 'cheap-illus', price: 10 }),
      flightOffer({ id: 'expensive-bookable', price: 9999 }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    expect(result[0]!.offer.bookable).toBe(true);
    expect(result[1]!.offer.bookable).toBe(false);
  });

  it('cheap illustrative offer ranks last after expensive bookable offers', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      illustrativeOffer({ id: 'illus-1', price: 1 }),
      flightOffer({ id: 'flight-1', price: 5000 }),
      flightOffer({ id: 'flight-2', price: 3000 }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    const ids = result.map((r) => r.offer.id);
    expect(ids.indexOf('illus-1')).toBeGreaterThan(ids.indexOf('flight-1'));
    expect(ids.indexOf('illus-1')).toBeGreaterThan(ids.indexOf('flight-2'));
  });

  it('all non-bookable offers sort after all bookable offers', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      illustrativeOffer({ id: 'i1', price: 1 }),
      illustrativeOffer({ id: 'i2', price: 2 }),
      flightOffer({ id: 'b1', price: 999 }),
      flightOffer({ id: 'b2', price: 888 }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    const bookableCount = result.filter((r) => r.offer.bookable).length;
    expect(result.slice(0, bookableCount).every((r) => r.offer.bookable)).toBe(true);
    expect(result.slice(bookableCount).every((r) => !r.offer.bookable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-filtering guarantee (AC2)
// ---------------------------------------------------------------------------

describe('OfferRanker — no-filtering guarantee (AC2)', () => {
  it('output set equals input set in membership under leisure preferences', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = {
      cabinClass: 'ECONOMY',
      homeAirports: ['LHR'],
    };
    const offers: Offer[] = [
      flightOffer({ id: 'f1', price: 500, details: { supplier: 'AMADEUS', cabinClass: 'BUSINESS', departureAirport: 'LHR' } }),
      flightOffer({ id: 'f2', price: 200, details: { supplier: 'RAPIDAPI', cabinClass: 'ECONOMY', departureAirport: 'LGW' } }),
      illustrativeOffer({ id: 'illus', price: 100 }),
    ];
    const result = ranker.rank(offers, prefs);
    const inputIds = new Set(offers.map((o) => o.id));
    const outputIds = new Set(result.map((r) => r.offer.id));
    expect(outputIds).toEqual(inputIds);
  });

  it('output set equals input set under business preferences', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { cabinClass: 'BUSINESS', minHotelStars: 4 };
    const offers: Offer[] = [
      flightOffer({ id: 'f1' }),
      flightOffer({ id: 'f2', price: 800, details: { supplier: 'AMADEUS', cabinClass: 'BUSINESS', departureAirport: 'LHR' } }),
      illustrativeOffer({ id: 'i1' }),
    ];
    const result = ranker.rank(offers, prefs);
    expect(new Set(result.map((r) => r.offer.id))).toEqual(new Set(offers.map((o) => o.id)));
  });

  it('output set equals input set under no preferences (guest persona)', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      flightOffer({ id: 'f1', price: 100 }),
      flightOffer({ id: 'f2', price: 200 }),
      flightOffer({ id: 'f3', price: 300 }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    expect(new Set(result.map((r) => r.offer.id))).toEqual(new Set(offers.map((o) => o.id)));
  });

  it('empty input produces empty output', () => {
    const ranker = makeRanker();
    expect(ranker.rank([], NO_PREFS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism (AC3)
// ---------------------------------------------------------------------------

describe('OfferRanker — determinism (AC3)', () => {
  const OFFERS: Offer[] = [
    flightOffer({ id: 'f1', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
    flightOffer({ id: 'f2', price: 200, details: { supplier: 'RAPIDAPI', cabinClass: 'BUSINESS', departureAirport: 'LGW' } }),
    flightOffer({ id: 'f3', price: 400, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
    illustrativeOffer({ id: 'i1', price: 50 }),
  ];
  const PREFS: MemberPreferences = { cabinClass: 'ECONOMY', homeAirports: ['LHR'] };

  it('same input produces identical order on two calls', () => {
    const ranker = makeRanker();
    const result1 = ranker.rank(OFFERS, PREFS);
    const result2 = ranker.rank(OFFERS, PREFS);
    expect(result1.map((r) => r.offer.id)).toEqual(result2.map((r) => r.offer.id));
  });

  it('shuffled input produces same order as unshuffled', () => {
    const ranker = makeRanker();
    const shuffled = [...OFFERS].reverse();
    const r1 = ranker.rank(OFFERS, PREFS);
    const r2 = ranker.rank(shuffled, PREFS);
    expect(r1.map((r) => r.offer.id)).toEqual(r2.map((r) => r.offer.id));
  });

  it('identical score offers are sorted by price ascending', () => {
    const ranker = makeRanker();
    // All same cabinClass/airport match → all get same bonus; price determines order
    const offers: Offer[] = [
      flightOffer({ id: 'expensive', price: 500, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
      flightOffer({ id: 'cheap', price: 100, details: { supplier: 'RAPIDAPI', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
      flightOffer({ id: 'mid', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
    ];
    const prefs: MemberPreferences = { cabinClass: 'ECONOMY', homeAirports: ['LHR'] };
    const result = ranker.rank(offers, prefs);
    // All have same bonus; normalised price gives highest score to cheapest
    // Cheapest offer gets score = priceWeight * (500-100)/(500-100) = 100 + bonuses
    // But since all have same bonuses, order is by normalized price DESC = price ASC
    expect(result[0]!.offer.id).toBe('cheap');
    expect(result[result.length - 1]!.offer.id).toBe('expensive');
  });

  it('tie-break uses supplier name ascending when prices equal', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      flightOffer({ id: 'z-offer', price: 300, details: { supplier: 'ZETA_AIR', cabinClass: 'ECONOMY' } }),
      flightOffer({ id: 'a-offer', price: 300, details: { supplier: 'ALPHA_AIR', cabinClass: 'ECONOMY' } }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    // All prices equal, all bonuses equal, tie-break: supplier ascending
    expect(result[0]!.offer.id).toBe('a-offer');
    expect(result[1]!.offer.id).toBe('z-offer');
  });

  it('tie-break uses offer id ascending when price and supplier equal', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [
      flightOffer({ id: 'z-id', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY' } }),
      flightOffer({ id: 'a-id', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY' } }),
    ];
    const result = ranker.rank(offers, NO_PREFS);
    expect(result[0]!.offer.id).toBe('a-id');
    expect(result[1]!.offer.id).toBe('z-id');
  });
});

// ---------------------------------------------------------------------------
// Preference ordering
// ---------------------------------------------------------------------------

describe('OfferRanker — preference ordering', () => {
  it('cabin class match ranks above non-matching at same price', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { cabinClass: 'BUSINESS' };
    const offers: Offer[] = [
      flightOffer({ id: 'economy-offer', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY' } }),
      flightOffer({ id: 'business-offer', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'BUSINESS' } }),
    ];
    const result = ranker.rank(offers, prefs);
    expect(result[0]!.offer.id).toBe('business-offer');
    expect(result[1]!.offer.id).toBe('economy-offer');
  });

  it('hotel star >= minHotelStars ranks above below-preference star hotels', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { minHotelStars: 4 };
    const hotelOffer = (id: string, rating: number): Offer => ({
      id,
      provenance: 'RAPIDAPI',
      bookable: true,
      title: `Hotel ${id}`,
      price: 200,
      currency: 'USD',
      rating,
      details: { supplier: 'RAPIDAPI' },
      expiresAt: new Date('2028-12-31T23:59:59Z'),
      freshness: 'FRESH',
    });
    const offers: Offer[] = [
      hotelOffer('3-star', 3),
      hotelOffer('5-star', 5),
      hotelOffer('4-star', 4),
    ];
    const result = ranker.rank(offers, prefs);
    const topTwo = result.slice(0, 2).map((r) => r.offer.id);
    expect(topTwo).toContain('4-star');
    expect(topTwo).toContain('5-star');
    expect(result[2]!.offer.id).toBe('3-star');
  });

  it('car class match ranks above non-matching at same price', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { carClass: 'COMPACT' };
    const carOffer = (id: string, vehicleClass: string): Offer => ({
      id,
      provenance: 'RAPIDAPI',
      bookable: true,
      title: `Car ${id}`,
      price: 100,
      currency: 'USD',
      details: { supplier: 'RAPIDAPI', vehicleClass },
      expiresAt: new Date('2028-12-31T23:59:59Z'),
      freshness: 'FRESH',
    });
    const offers: Offer[] = [
      carOffer('economy-car', 'ECONOMY'),
      carOffer('compact-car', 'COMPACT'),
    ];
    const result = ranker.rank(offers, prefs);
    expect(result[0]!.offer.id).toBe('compact-car');
  });

  it('home airport match ranks above non-matching at same price', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { homeAirports: ['LHR'] };
    const offers: Offer[] = [
      flightOffer({ id: 'lgw-flight', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LGW' } }),
      flightOffer({ id: 'lhr-flight', price: 300, details: { supplier: 'AMADEUS', cabinClass: 'ECONOMY', departureAirport: 'LHR' } }),
    ];
    const result = ranker.rank(offers, prefs);
    expect(result[0]!.offer.id).toBe('lhr-flight');
  });

  it('hotel without rating does not receive star bonus regardless of minHotelStars', () => {
    const ranker = makeRanker();
    const prefs: MemberPreferences = { minHotelStars: 3 };
    const withRating: Offer = {
      id: 'with-rating',
      provenance: 'RAPIDAPI',
      bookable: true,
      title: 'Hotel with rating',
      price: 200,
      currency: 'USD',
      rating: 4,
      details: { supplier: 'RAPIDAPI' },
      expiresAt: new Date('2028-12-31T23:59:59Z'),
      freshness: 'FRESH',
    };
    const withoutRating: Offer = {
      id: 'without-rating',
      provenance: 'RAPIDAPI',
      bookable: true,
      title: 'Hotel without rating',
      price: 200,
      currency: 'USD',
      details: { supplier: 'RAPIDAPI' },
      expiresAt: new Date('2028-12-31T23:59:59Z'),
      freshness: 'FRESH',
    };
    const result = ranker.rank([withoutRating, withRating], prefs);
    // withRating gets star bonus, withoutRating does not — should rank first
    expect(result[0]!.offer.id).toBe('with-rating');
  });

  it('no preferences — single offer sorts by price ascending (only offer)', () => {
    const ranker = makeRanker();
    const offers: Offer[] = [flightOffer({ id: 'only-flight', price: 250 })];
    const result = ranker.rank(offers, NO_PREFS);
    expect(result[0]!.offer.id).toBe('only-flight');
  });
});

// ---------------------------------------------------------------------------
// Ranking explanation (AC6)
// ---------------------------------------------------------------------------

describe('OfferRanker — ranking explanation (AC6)', () => {
  it('includes rankingExplanation when exposeRankingExplanation=true', () => {
    const ranker = makeRanker({ exposeRankingExplanation: true });
    const offers: Offer[] = [flightOffer({ id: 'f1' })];
    const result = ranker.rank(offers, NO_PREFS);
    expect(result[0]!.rankingExplanation).toBeDefined();
    expect(typeof result[0]!.rankingExplanation!.score).toBe('number');
    expect(typeof result[0]!.rankingExplanation!.priceComponent).toBe('number');
    expect(Array.isArray(result[0]!.rankingExplanation!.matchedPreferences)).toBe(true);
    expect(typeof result[0]!.rankingExplanation!.bonuses).toBe('object');
  });

  it('omits rankingExplanation when exposeRankingExplanation=false', () => {
    const ranker = makeRanker({ exposeRankingExplanation: false });
    const offers: Offer[] = [flightOffer({ id: 'f1' })];
    const result = ranker.rank(offers, NO_PREFS);
    expect(result[0]!.rankingExplanation).toBeUndefined();
  });

  it('explanation lists matched preferences when bonus applies', () => {
    const ranker = makeRanker({ exposeRankingExplanation: true });
    const prefs: MemberPreferences = { cabinClass: 'BUSINESS', homeAirports: ['LHR'] };
    const offers: Offer[] = [
      flightOffer({
        id: 'f1',
        price: 800,
        details: { supplier: 'AMADEUS', cabinClass: 'BUSINESS', departureAirport: 'LHR' },
      }),
    ];
    const result = ranker.rank(offers, prefs);
    const matched = result[0]!.rankingExplanation!.matchedPreferences;
    expect(matched).toContain('cabinClass');
    expect(matched).toContain('homeAirport');
  });

  it('explanation bonuses are non-negative numbers', () => {
    const ranker = makeRanker({ exposeRankingExplanation: true });
    const offers: Offer[] = [flightOffer({ id: 'f1', price: 300 }), flightOffer({ id: 'f2', price: 200 })];
    const result = ranker.rank(offers, NO_PREFS);
    for (const r of result) {
      for (const v of Object.values(r.rankingExplanation!.bonuses)) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validateWeights
// ---------------------------------------------------------------------------

describe('validateWeights', () => {
  it('accepts valid weights', () => {
    expect(() => validateWeights(DEFAULT_RANKING_WEIGHTS)).not.toThrow();
  });

  it('throws on negative priceWeight', () => {
    expect(() =>
      validateWeights({ ...DEFAULT_RANKING_WEIGHTS, priceWeight: -1 }),
    ).toThrow();
  });

  it('throws on NaN weight', () => {
    expect(() =>
      validateWeights({ ...DEFAULT_RANKING_WEIGHTS, cabinClassMatchBonus: NaN }),
    ).toThrow();
  });

  it('throws on Infinity weight', () => {
    expect(() =>
      validateWeights({ ...DEFAULT_RANKING_WEIGHTS, hotelStarMatchBonus: Infinity }),
    ).toThrow();
  });

  it('accepts zero weights (effectively disabling a dimension)', () => {
    expect(() =>
      validateWeights({ ...DEFAULT_RANKING_WEIGHTS, carClassMatchBonus: 0 }),
    ).not.toThrow();
  });

  it('throws if invalid weights are passed to OfferRanker constructor', () => {
    expect(() =>
      new OfferRanker({
        config: {
          weights: { ...DEFAULT_RANKING_WEIGHTS, priceWeight: -5 },
          exposeRankingExplanation: false,
        },
      }),
    ).toThrow();
  });
});
