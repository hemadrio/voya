/**
 * Unit tests for rapidApiHotelMapper.
 *
 * Covers: field mapping, nightly price derivation, star-rating coercion,
 * optional review signals, deterministic offer ID, empty result set.
 * No network calls are made.
 */

import { describe, it, expect } from 'vitest';
import {
  mapRapidApiHotelOffers,
  computeNights,
  coerceStarRating,
  buildHotelSearchFingerprint,
} from '../../src/adapters/mappers/rapidApiHotelMapper.js';
import type { RapidApiHotelSearchResponse } from '../../src/adapters/mappers/rapidApiHotelMapper.js';
import multiFixture from '../fixtures/rapidapi-hotel/multi-property-success.json';
import noReviewFixture from '../fixtures/rapidapi-hotel/no-review-data.json';
import stringStarFixture from '../fixtures/rapidapi-hotel/string-star-rating.json';
import emptyFixture from '../fixtures/rapidapi-hotel/empty-results.json';
import type { HotelSearchCriteria } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_CRITERIA: HotelSearchCriteria = {
  kind: 'hotel',
  location: 'New York',
  checkInDate: new Date('2028-03-15T00:00:00Z'),
  checkOutDate: new Date('2028-03-18T00:00:00Z'),
  guests: 2,
  currency: 'USD',
};

const NOW = new Date('2028-03-01T12:00:00Z');
const DEFAULT_VALIDITY_MINUTES = 30;

// ---------------------------------------------------------------------------
// computeNights
// ---------------------------------------------------------------------------

describe('computeNights', () => {
  it('returns 3 for a 3-night stay', () => {
    const checkIn = new Date('2028-03-15T00:00:00Z');
    const checkOut = new Date('2028-03-18T00:00:00Z');
    expect(computeNights(checkIn, checkOut)).toBe(3);
  });

  it('returns 1 for a same-day (24h) stay', () => {
    const checkIn = new Date('2028-03-15T00:00:00Z');
    const checkOut = new Date('2028-03-16T00:00:00Z');
    expect(computeNights(checkIn, checkOut)).toBe(1);
  });

  it('returns at least 1 even if checkout equals checkin (guarded against divide-by-zero)', () => {
    const d = new Date('2028-03-15T00:00:00Z');
    expect(computeNights(d, d)).toBe(1);
  });

  it('rounds fractional days up (ceiling)', () => {
    const checkIn = new Date('2028-03-15T00:00:00Z');
    const checkOut = new Date('2028-03-16T12:00:00Z');
    expect(computeNights(checkIn, checkOut)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// coerceStarRating
// ---------------------------------------------------------------------------

describe('coerceStarRating', () => {
  it('returns the value for integer numeric input', () => {
    expect(coerceStarRating(4)).toBe(4);
    expect(coerceStarRating(3)).toBe(3);
  });

  it('returns the value for half-star numeric input', () => {
    expect(coerceStarRating(4.5)).toBe(4.5);
  });

  it('parses a numeric string', () => {
    expect(coerceStarRating('4')).toBe(4);
    expect(coerceStarRating('4.5')).toBe(4.5);
    expect(coerceStarRating('3.0')).toBe(3);
  });

  it('returns null for null input (never defaults)', () => {
    expect(coerceStarRating(null)).toBeNull();
  });

  it('returns null for undefined input (never defaults)', () => {
    expect(coerceStarRating(undefined)).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    expect(coerceStarRating('excellent')).toBeNull();
    expect(coerceStarRating('')).toBeNull();
  });

  it('clamps values above 5 to 5', () => {
    expect(coerceStarRating(6)).toBe(5);
    expect(coerceStarRating('7')).toBe(5);
  });

  it('returns null for negative values', () => {
    expect(coerceStarRating(-1)).toBeNull();
  });

  it('returns null for non-number, non-string types', () => {
    expect(coerceStarRating({})).toBeNull();
    expect(coerceStarRating([])).toBeNull();
    expect(coerceStarRating(true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiHotelOffers — multi-property fixture
// ---------------------------------------------------------------------------

describe('mapRapidApiHotelOffers — multi-property success', () => {
  it('returns 2 offers from the multi-property fixture', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers).toHaveLength(2);
  });

  it('sets provenance RAPIDAPI and bookable true on every offer', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    for (const offer of offers) {
      expect(offer.provenance).toBe('RAPIDAPI');
      expect(offer.bookable).toBe(true);
    }
  });

  it('sets title to the property name', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.title).toBe('Grand Hotel Times Square');
    expect(offers[1]!.title).toBe('Budget Inn Midtown');
  });

  it('derives nightly price from total price / nights', () => {
    // checkIn 2028-03-15, checkOut 2028-03-18 → 3 nights
    // Hotel A: 450 / 3 = 150.00
    // Hotel B: 240 / 3 = 80.00
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.price).toBe(150);
    expect(offers[1]!.price).toBe(80);
  });

  it('stores totalPrice and nights in details', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.details['totalPrice']).toBe(450);
    expect(offers[0]!.details['nights']).toBe(3);
  });

  it('sets currency from provider', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.currency).toBe('USD');
  });

  it('sets star rating from numeric class field', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.rating).toBe(4);
    expect(offers[1]!.rating).toBe(3);
  });

  it('sets review count from review_nr', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.reviews).toBe(2847);
    expect(offers[1]!.reviews).toBe(1203);
  });

  it('stores reviewScore in details', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.details['reviewScore']).toBe(8.7);
  });

  it('assigns an expiresAt Date = now + defaultValidityMinutes', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    const expected = new Date(NOW.getTime() + DEFAULT_VALIDITY_MINUTES * 60_000);
    for (const offer of offers) {
      expect(offer.expiresAt).toBeInstanceOf(Date);
      expect((offer.expiresAt as Date).getTime()).toBe(expected.getTime());
    }
  });

  it('sets freshness FRESH', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    for (const offer of offers) {
      expect(offer.freshness).toBe('FRESH');
    }
  });

  it('produces deterministic and unique offer IDs', () => {
    const offers = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.id).toHaveLength(64); // sha256 hex
    expect(offers[0]!.id).not.toBe(offers[1]!.id);
    // Same search, same fixture → same ID
    const offers2 = mapRapidApiHotelOffers(
      multiFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      new Date('2028-03-02T00:00:00Z'), // different now → same ID (ID is not time-based)
    );
    expect(offers[0]!.id).toBe(offers2[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiHotelOffers — no-review-data fixture
// ---------------------------------------------------------------------------

describe('mapRapidApiHotelOffers — no review data', () => {
  it('omits reviews field when review_nr is null (never invented)', () => {
    const offers = mapRapidApiHotelOffers(
      noReviewFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]!.reviews).toBeUndefined();
  });

  it('omits reviewScore from details when review_score is null', () => {
    const offers = mapRapidApiHotelOffers(
      noReviewFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.details['reviewScore']).toBeUndefined();
  });

  it('still includes star rating when class is present', () => {
    const offers = mapRapidApiHotelOffers(
      noReviewFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers[0]!.rating).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiHotelOffers — string-star-rating fixture
// ---------------------------------------------------------------------------

describe('mapRapidApiHotelOffers — string star rating', () => {
  it('coerces string star rating "4.5" to 4.5', () => {
    const offers = mapRapidApiHotelOffers(
      stringStarFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]!.rating).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiHotelOffers — empty results fixture
// ---------------------------------------------------------------------------

describe('mapRapidApiHotelOffers — empty results', () => {
  it('returns empty array for an empty result set', () => {
    const offers = mapRapidApiHotelOffers(
      emptyFixture as RapidApiHotelSearchResponse,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      NOW,
    );
    expect(offers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nightly price derivation — edge cases
// ---------------------------------------------------------------------------

describe('nightly price derivation', () => {
  it('rounds to at most 2 decimal places', () => {
    const fixture: RapidApiHotelSearchResponse = {
      result: [
        {
          hotel_id: 'test-99',
          hotel_name: 'Test Hotel',
          class: 4,
          min_total_price: 100,
          currencycode: 'USD',
        },
      ],
    };
    const criteria: HotelSearchCriteria = {
      ...BASE_CRITERIA,
      // 7 nights: 100 / 7 = 14.285... → rounds to 14.29
      checkInDate: new Date('2028-03-15T00:00:00Z'),
      checkOutDate: new Date('2028-03-22T00:00:00Z'),
    };
    const offers = mapRapidApiHotelOffers(fixture, criteria, DEFAULT_VALIDITY_MINUTES, NOW);
    const nightlyPrice = offers[0]!.price;
    // 100 / 7 ≈ 14.285714... → Math.round(14.285714... * 100) / 100 = 14.29
    expect(nightlyPrice).toBe(14.29);
    // Verify at most 2 decimal places
    const decimalPlaces = (String(nightlyPrice).split('.')[1] ?? '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(2);
  });

  it('produces exact integer price when total is divisible by nights', () => {
    const fixture: RapidApiHotelSearchResponse = {
      result: [
        {
          hotel_id: 'test-100',
          hotel_name: 'Test Hotel',
          class: 3,
          min_total_price: 450,
          currencycode: 'USD',
        },
      ],
    };
    const offers = mapRapidApiHotelOffers(fixture, BASE_CRITERIA, DEFAULT_VALIDITY_MINUTES, NOW);
    expect(offers[0]!.price).toBe(150); // 450 / 3 = 150
  });

  it('stores correct nights count for different stay durations', () => {
    const fixture: RapidApiHotelSearchResponse = {
      result: [
        { hotel_id: 'h1', hotel_name: 'H1', min_total_price: 500, currencycode: 'USD' },
      ],
    };
    const criteria5: HotelSearchCriteria = {
      ...BASE_CRITERIA,
      checkInDate: new Date('2028-03-15T00:00:00Z'),
      checkOutDate: new Date('2028-03-20T00:00:00Z'), // 5 nights
    };
    const offers = mapRapidApiHotelOffers(fixture, criteria5, DEFAULT_VALIDITY_MINUTES, NOW);
    expect(offers[0]!.details['nights']).toBe(5);
    expect(offers[0]!.price).toBe(100); // 500 / 5 = 100
  });
});

// ---------------------------------------------------------------------------
// Search fingerprint
// ---------------------------------------------------------------------------

describe('buildHotelSearchFingerprint', () => {
  it('returns a 16-character hex string', () => {
    const fp = buildHotelSearchFingerprint(BASE_CRITERIA);
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces different fingerprints for different locations', () => {
    const fp1 = buildHotelSearchFingerprint(BASE_CRITERIA);
    const fp2 = buildHotelSearchFingerprint({ ...BASE_CRITERIA, location: 'London' });
    expect(fp1).not.toBe(fp2);
  });
});
