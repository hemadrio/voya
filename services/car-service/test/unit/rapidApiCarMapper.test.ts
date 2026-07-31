/**
 * Unit tests for rapidApiCarMapper.
 *
 * Covers: rental day computation, price derivation, vehicleClass mapping,
 * deterministic offer ID, provenance, expiresAt, empty results, unmapped classes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  mapRapidApiCarOffers,
  computeRentalDays,
  buildCarSearchFingerprint,
  type RapidApiCarSearchResponse,
} from '../../src/adapters/mappers/rapidApiCarMapper.js';
import type { CarSearchCriteria } from '@travel/supplier-port';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): RapidApiCarSearchResponse {
  const p = resolve(__dirname, '../fixtures/rapidapi-car', name);
  return JSON.parse(readFileSync(p, 'utf8')) as RapidApiCarSearchResponse;
}

const FIXED_NOW = new Date('2028-03-15T10:00:00.000Z');
const PICKUP_DATE = new Date('2028-03-15');
const DROPOFF_DATE = new Date('2028-03-18');
const DEFAULT_VALIDITY_MINUTES = 30;

const BASE_CRITERIA: CarSearchCriteria = {
  kind: 'car',
  pickupLocation: 'JFK',
  dropoffLocation: 'JFK',
  pickupDate: PICKUP_DATE,
  dropoffDate: DROPOFF_DATE,
  carClass: 'ECONOMY',
  currency: 'USD',
};

// ---------------------------------------------------------------------------
// computeRentalDays
// ---------------------------------------------------------------------------

describe('computeRentalDays', () => {
  it('returns 3 for a 3-day rental', () => {
    expect(computeRentalDays(PICKUP_DATE, DROPOFF_DATE)).toBe(3);
  });

  it('returns 1 for same-day pickup and dropoff (minimum)', () => {
    const same = new Date('2028-03-15');
    expect(computeRentalDays(same, same)).toBe(1);
  });

  it('rounds up partial days (36-hour = 2 days)', () => {
    const start = new Date('2028-03-15T00:00:00Z');
    const end = new Date('2028-03-16T12:00:00Z');
    expect(computeRentalDays(start, end)).toBe(2);
  });

  it('handles 1 full day', () => {
    const start = new Date('2028-03-15T00:00:00Z');
    const end = new Date('2028-03-16T00:00:00Z');
    expect(computeRentalDays(start, end)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildCarSearchFingerprint
// ---------------------------------------------------------------------------

describe('buildCarSearchFingerprint', () => {
  it('returns a 16-character hex string', () => {
    const fp = buildCarSearchFingerprint(BASE_CRITERIA);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it('produces the same fingerprint for identical criteria', () => {
    const fp1 = buildCarSearchFingerprint(BASE_CRITERIA);
    const fp2 = buildCarSearchFingerprint({ ...BASE_CRITERIA });
    expect(fp1).toBe(fp2);
  });

  it('produces a different fingerprint when criteria differ', () => {
    const fp1 = buildCarSearchFingerprint(BASE_CRITERIA);
    const fp2 = buildCarSearchFingerprint({ ...BASE_CRITERIA, pickupLocation: 'LAX' });
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiCarOffers — multi-vehicle success
// ---------------------------------------------------------------------------

describe('mapRapidApiCarOffers — multi-vehicle success fixture', () => {
  const fixture = loadFixture('multi-vehicle-success.json');

  it('returns 3 offers with no unmapped descriptions', () => {
    const { offers, unmappedDescriptions } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    expect(offers).toHaveLength(3);
    expect(unmappedDescriptions).toHaveLength(0);
  });

  it('maps economy vehicle correctly', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    const economy = offers[0];
    expect(economy).toBeDefined();
    expect(economy!.provenance).toBe('RAPIDAPI');
    expect(economy!.bookable).toBe(true);
    expect(economy!.title).toBe('Toyota Yaris or similar');
    expect(economy!.price).toBe(120);
    expect(economy!.currency).toBe('USD');
    expect((economy!.details as Record<string, unknown>)['vehicleClass']).toBe('ECONOMY');
    expect((economy!.details as Record<string, unknown>)['sippCode']).toBe('ECAR');
    expect((economy!.details as Record<string, unknown>)['totalPrice']).toBe(120);
    expect((economy!.details as Record<string, unknown>)['rentalDays']).toBe(3);
    expect((economy!.details as Record<string, unknown>)['dailyRate']).toBe(40);
    expect((economy!.details as Record<string, unknown>)['supplier']).toBe('RAPIDAPI');
    expect(economy!.freshness).toBe('FRESH');
  });

  it('maps premium SUV vehicle correctly (Premium category)', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    const premium = offers[2];
    expect(premium).toBeDefined();
    expect(premium!.price).toBe(270);
    expect((premium!.details as Record<string, unknown>)['vehicleClass']).toBe('PREMIUM');
    expect((premium!.details as Record<string, unknown>)['sippCode']).toBe('PFAR');
  });

  it('sets expiresAt to now + defaultValidityMinutes', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    const expectedExpiry = new Date(FIXED_NOW.getTime() + DEFAULT_VALIDITY_MINUTES * 60_000);
    for (const offer of offers) {
      expect(offer.expiresAt?.toISOString()).toBe(expectedExpiry.toISOString());
    }
  });

  it('generates deterministic offer IDs (same criteria = same IDs)', () => {
    const { offers: first } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    const { offers: second } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      new Date(FIXED_NOW.getTime() + 1000),
    );
    for (let i = 0; i < first.length; i++) {
      expect(first[i]!.id).toBe(second[i]!.id);
    }
  });

  it('offer IDs are sha256("RAPIDAPI-CAR:vehicleId:fingerprint")', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    const fingerprint = buildCarSearchFingerprint(BASE_CRITERIA);
    const expectedId = createHash('sha256')
      .update(`RAPIDAPI-CAR:car-001:${fingerprint}`)
      .digest('hex');
    expect(offers[0]!.id).toBe(expectedId);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiCarOffers — total price derivation from daily rate
// ---------------------------------------------------------------------------

describe('mapRapidApiCarOffers — unmapped-class fixture (daily rate only)', () => {
  const fixture = loadFixture('unmapped-class.json');

  it('returns 1 offer with 1 unmapped description', () => {
    const { offers, unmappedDescriptions } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    expect(offers).toHaveLength(1);
    expect(unmappedDescriptions).toHaveLength(1);
    expect(unmappedDescriptions[0]).toBe('Motorsport Cabriolet Turbo');
  });

  it('derives total price from daily rate * rentalDays', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    // $116/day × 3 days = $348
    expect(offers[0]!.price).toBe(348);
    expect((offers[0]!.details as Record<string, unknown>)['totalPrice']).toBe(348);
    expect((offers[0]!.details as Record<string, unknown>)['dailyRate']).toBe(116);
  });

  it('sets vehicleClass to UNKNOWN', () => {
    const { offers } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    expect((offers[0]!.details as Record<string, unknown>)['vehicleClass']).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiCarOffers — empty results
// ---------------------------------------------------------------------------

describe('mapRapidApiCarOffers — empty-results fixture', () => {
  it('returns 0 offers and 0 unmapped descriptions', () => {
    const fixture = loadFixture('empty-results.json');
    const { offers, unmappedDescriptions } = mapRapidApiCarOffers(
      fixture,
      BASE_CRITERIA,
      DEFAULT_VALIDITY_MINUTES,
      FIXED_NOW,
    );
    expect(offers).toHaveLength(0);
    expect(unmappedDescriptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mapRapidApiCarOffers — currency fallback
// ---------------------------------------------------------------------------

describe('mapRapidApiCarOffers — currency', () => {
  it('uppercases currency from response', () => {
    const resp: RapidApiCarSearchResponse = {
      search_results: [
        {
          vehicle_id: 'x1',
          vehicle_name: 'Test Car',
          vehicle_category: 'Economy',
          total_price: 100,
          currency: 'eur',
        },
      ],
    };
    const { offers } = mapRapidApiCarOffers(resp, BASE_CRITERIA, 30, FIXED_NOW);
    expect(offers[0]!.currency).toBe('EUR');
  });

  it('falls back to criteria.currency when response omits currency', () => {
    const resp: RapidApiCarSearchResponse = {
      search_results: [
        {
          vehicle_id: 'x2',
          vehicle_name: 'Test Car',
          vehicle_category: 'Compact',
          total_price: 80,
        },
      ],
    };
    const criteria = { ...BASE_CRITERIA, currency: 'GBP' };
    const { offers } = mapRapidApiCarOffers(resp, criteria, 30, FIXED_NOW);
    expect(offers[0]!.currency).toBe('GBP');
  });
});
