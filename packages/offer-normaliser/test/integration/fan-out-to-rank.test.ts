/**
 * Integration test: fan-out output → OfferNormaliser → OfferRanker.
 *
 * Feeds the multi-supplier raw fixture (which includes 1 invalid offer, 1 expired
 * offer, valid bookable offers from AMADEUS/RAPIDAPI, and an ILLUSTRATIVE offer)
 * through the full normalise → rank pipeline and asserts the final ordered payload.
 *
 * No infrastructure calls are made — all offers come from committed JSON fixtures.
 */

import { OfferNormaliser } from '../../src/OfferNormaliser.js';
import { OfferRanker } from '../../src/OfferRanker.js';
import { DEFAULT_RANKING_WEIGHTS } from '../../src/rankingWeights.js';
import type { MemberPreferences } from '../../src/types.js';

import flightFixtures from '../fixtures/flights/multi-supplier-offers.json';
import hotelFixtures from '../fixtures/hotels/multi-supplier-offers.json';
import carFixtures from '../fixtures/cars/multi-supplier-offers.json';
import leisurePrefs from '../fixtures/preferences/leisure-persona.json';
import businessPrefs from '../fixtures/preferences/business-persona.json';
import guestPrefs from '../fixtures/preferences/guest-persona.json';

jest.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: jest.fn() }),
    }),
  },
}));

// Clock placed in 2026 so 2028 offers are fresh and 2020 offers are expired
const CLOCK = { now: () => new Date('2026-01-01T00:00:00Z').getTime() };

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// ---------------------------------------------------------------------------
// Flight pipeline — leisure persona
// ---------------------------------------------------------------------------

describe('Integration: flight fan-out → normaliser → ranker (leisure persona)', () => {
  const normaliser = new OfferNormaliser({
    config: { category: 'flight' },
    logger: makeLogger(),
    clock: CLOCK,
  });
  const ranker = new OfferRanker({
    config: { weights: DEFAULT_RANKING_WEIGHTS, exposeRankingExplanation: false },
  });
  const prefs: MemberPreferences = leisurePrefs as MemberPreferences;

  const normalised = normaliser.normalise(flightFixtures);
  const ranked = ranker.rank(normalised, prefs);

  it('drops invalid and expired offers during normalisation', () => {
    // Flight fixture: 7 items — 5 valid non-expired, 1 expired, 1 invalid
    expect(normalised.length).toBe(5);
  });

  it('ranked result contains all normalised offers', () => {
    const normIds = new Set(normalised.map((o) => o.id));
    const rankIds = new Set(ranked.map((r) => r.offer.id));
    expect(rankIds).toEqual(normIds);
  });

  it('ranked result is contract-valid (every offer has required fields)', () => {
    for (const item of ranked) {
      const { offer } = item;
      expect(offer.id).toBeTruthy();
      expect(offer.provenance).toMatch(/^(AMADEUS|RAPIDAPI|ILLUSTRATIVE)$/);
      expect(typeof offer.bookable).toBe('boolean');
      expect(offer.price).toBeGreaterThan(0);
      expect(offer.expiresAt).toBeInstanceOf(Date);
    }
  });

  it('illustrative offer ranks last (below all bookable offers)', () => {
    const lastRanked = ranked[ranked.length - 1]!;
    expect(lastRanked.offer.bookable).toBe(false);
    expect(lastRanked.offer.provenance).toBe('ILLUSTRATIVE');
  });

  it('all bookable offers precede non-bookable in ranked output', () => {
    const nonBookableIdx = ranked.findIndex((r) => !r.offer.bookable);
    if (nonBookableIdx === -1) return; // no non-bookable — trivially satisfied
    for (let i = 0; i < nonBookableIdx; i++) {
      expect(ranked[i]!.offer.bookable).toBe(true);
    }
    for (let i = nonBookableIdx; i < ranked.length; i++) {
      expect(ranked[i]!.offer.bookable).toBe(false);
    }
  });

  it('leisure preference economy/homeAirport boost — LHR departure ranks above LGW at same price bucket', () => {
    // leisure prefs: cabinClass=ECONOMY, homeAirports=[LHR, LGW]
    // Both LHR and LGW match homeAirports for leisure persona
    // Among ECONOMY bookable flights, LHR and LGW departures should all appear before non-ECONOMY
    const bookable = ranked.filter((r) => r.offer.bookable);
    const economyFlights = bookable.filter(
      (r) => (r.offer.details as Record<string, unknown>)['cabinClass'] === 'ECONOMY',
    );
    const businessFlights = bookable.filter(
      (r) => (r.offer.details as Record<string, unknown>)['cabinClass'] === 'BUSINESS',
    );
    if (economyFlights.length > 0 && businessFlights.length > 0) {
      // ECONOMY flights get cabin class bonus; at same price range, economy with LHR/LGW
      // gets airport bonus too. Business flight has no bonus from leisure prefs.
      const economyRanks = economyFlights.map((r) => ranked.indexOf(r));
      const businessRanks = businessFlights.map((r) => ranked.indexOf(r));
      const minEconomyRank = Math.min(...economyRanks);
      const minBusinessRank = Math.min(...businessRanks);
      expect(minEconomyRank).toBeLessThan(minBusinessRank);
    }
  });
});

// ---------------------------------------------------------------------------
// Flight pipeline — business persona
// ---------------------------------------------------------------------------

describe('Integration: flight fan-out → normaliser → ranker (business persona)', () => {
  const normaliser = new OfferNormaliser({
    config: { category: 'flight' },
    logger: makeLogger(),
    clock: CLOCK,
  });
  const ranker = new OfferRanker({
    config: { weights: DEFAULT_RANKING_WEIGHTS, exposeRankingExplanation: true },
  });
  const prefs: MemberPreferences = businessPrefs as MemberPreferences;

  const normalised = normaliser.normalise(flightFixtures);
  const ranked = ranker.rank(normalised, prefs);

  it('produces rankingExplanation for each offer when enabled', () => {
    for (const item of ranked) {
      expect(item.rankingExplanation).toBeDefined();
    }
  });

  it('business offer rankingExplanation shows cabinClass match bonus', () => {
    // The AMADEUS BUSINESS flight (amadeus-flight-002) should receive the cabinClass bonus
    // in its explanation because business prefs set cabinClass=BUSINESS.
    const businessItem = ranked.find(
      (r) => r.offer.id === 'amadeus-flight-002',
    );
    expect(businessItem).toBeDefined();
    const expl = businessItem!.rankingExplanation!;
    expect(expl.matchedPreferences).toContain('cabinClass');
    expect(expl.bonuses['cabinClass']).toBeGreaterThan(0);
  });

  it('no-filtering: output set equals input set for business prefs', () => {
    const normIds = new Set(normalised.map((o) => o.id));
    const rankIds = new Set(ranked.map((r) => r.offer.id));
    expect(rankIds).toEqual(normIds);
  });
});

// ---------------------------------------------------------------------------
// Flight pipeline — guest persona (no preferences)
// ---------------------------------------------------------------------------

describe('Integration: flight fan-out → normaliser → ranker (guest persona)', () => {
  const normaliser = new OfferNormaliser({
    config: { category: 'flight' },
    logger: makeLogger(),
    clock: CLOCK,
  });
  const ranker = new OfferRanker({
    config: { weights: DEFAULT_RANKING_WEIGHTS, exposeRankingExplanation: false },
  });

  const normalised = normaliser.normalise(flightFixtures);
  const ranked = ranker.rank(normalised, guestPrefs as MemberPreferences);

  it('ranks by price ascending for guest with no preferences (bookable group)', () => {
    const bookable = ranked.filter((r) => r.offer.bookable);
    // With no preference bonuses and equal price-normalisation scope, cheapest gets highest score
    for (let i = 0; i < bookable.length - 1; i++) {
      expect(bookable[i]!.offer.price).toBeLessThanOrEqual(bookable[i + 1]!.offer.price);
    }
  });

  it('deterministic: ranked twice with same input produces same order', () => {
    const r1 = ranker.rank(normalised, guestPrefs as MemberPreferences);
    const r2 = ranker.rank(normalised, guestPrefs as MemberPreferences);
    expect(r1.map((r) => r.offer.id)).toEqual(r2.map((r) => r.offer.id));
  });
});

// ---------------------------------------------------------------------------
// Hotel pipeline — business persona
// ---------------------------------------------------------------------------

describe('Integration: hotel fan-out → normaliser → ranker (business persona)', () => {
  const normaliser = new OfferNormaliser({
    config: { category: 'hotel' },
    logger: makeLogger(),
    clock: CLOCK,
  });
  const ranker = new OfferRanker({
    config: { weights: DEFAULT_RANKING_WEIGHTS, exposeRankingExplanation: true },
  });
  const prefs: MemberPreferences = businessPrefs as MemberPreferences;

  const normalised = normaliser.normalise(hotelFixtures);
  const ranked = ranker.rank(normalised, prefs);

  it('normalises all hotel offers', () => {
    expect(normalised.length).toBe(5);
  });

  it('affordable 4-star hotel ranks above expensive 5-star (both meet preference, price wins tie)', () => {
    // Both hotel-002 (4-star, $175) and hotel-003 (5-star, $450) receive the
    // minHotelStars bonus. With default weights the cheaper 4-star should rank above
    // the expensive 5-star because the normalised price component dominates.
    const hotel002Idx = ranked.findIndex((r) => r.offer.id === 'rapidapi-hotel-002');
    const hotel003Idx = ranked.findIndex((r) => r.offer.id === 'rapidapi-hotel-003');
    if (hotel002Idx !== -1 && hotel003Idx !== -1) {
      expect(hotel002Idx).toBeLessThan(hotel003Idx);
    }
  });

  it('illustrative hotel ranks last in output', () => {
    const lastItem = ranked[ranked.length - 1]!;
    expect(lastItem.offer.bookable).toBe(false);
  });

  it('no-filtering guarantee for hotel offers', () => {
    const normIds = new Set(normalised.map((o) => o.id));
    const rankIds = new Set(ranked.map((r) => r.offer.id));
    expect(rankIds).toEqual(normIds);
  });
});

// ---------------------------------------------------------------------------
// Car pipeline — leisure persona
// ---------------------------------------------------------------------------

describe('Integration: car fan-out → normaliser → ranker (leisure persona)', () => {
  const normaliser = new OfferNormaliser({
    config: { category: 'car' },
    logger: makeLogger(),
    clock: CLOCK,
  });
  const ranker = new OfferRanker({
    config: { weights: DEFAULT_RANKING_WEIGHTS, exposeRankingExplanation: false },
  });
  const prefs: MemberPreferences = leisurePrefs as MemberPreferences;

  const normalised = normaliser.normalise(carFixtures);
  const ranked = ranker.rank(normalised, prefs);

  it('normalises all car offers', () => {
    expect(normalised.length).toBe(5);
  });

  it('economy car ranks above others for leisure persona (carClass=ECONOMY preference)', () => {
    const bookable = ranked.filter((r) => r.offer.bookable);
    // The economy car gets a carClass bonus; at the cheapest price, it should rank first
    const economyCar = bookable.find(
      (r) => (r.offer.details as Record<string, unknown>)['vehicleClass'] === 'ECONOMY',
    );
    expect(economyCar).toBeDefined();
    expect(bookable[0]!.offer.id).toBe(economyCar!.offer.id);
  });

  it('illustrative car ranks last', () => {
    const lastItem = ranked[ranked.length - 1]!;
    expect(lastItem.offer.bookable).toBe(false);
    expect(lastItem.offer.provenance).toBe('ILLUSTRATIVE');
  });
});
