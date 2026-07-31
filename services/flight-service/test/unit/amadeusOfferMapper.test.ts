/**
 * Unit tests for amadeusOfferMapper.
 *
 * Tests exact field mapping, expiresAt fallback, multi-segment stop counts,
 * currency pass-through, deterministic ID, and empty-data edge case.
 */

import { describe, it, expect } from 'vitest';
import { mapAmadeusOffers, buildSearchFingerprint } from '../../src/adapters/mappers/amadeusOfferMapper.js';
import multiOfferFixture from '../fixtures/amadeus/multi-offer-search.json';
import emptyFixture from '../fixtures/amadeus/empty-availability.json';
import type { FlightSearchCriteria } from '@travel/supplier-port';

const BASE_CRITERIA: FlightSearchCriteria = {
  kind: 'flight',
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: new Date('2028-03-15T00:00:00Z'),
  passengers: 1,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

const NOW = new Date('2028-03-13T10:00:00Z');
const DEFAULT_VALIDITY_MINUTES = 60;

describe('mapAmadeusOffers — multi-offer fixture', () => {
  const offers = mapAmadeusOffers(multiOfferFixture, BASE_CRITERIA, DEFAULT_VALIDITY_MINUTES, NOW);

  it('returns one Offer per data entry', () => {
    expect(offers).toHaveLength(2);
  });

  it('sets provenance to AMADEUS', () => {
    expect(offers[0]!.provenance).toBe('AMADEUS');
    expect(offers[1]!.provenance).toBe('AMADEUS');
  });

  it('sets bookable to true', () => {
    expect(offers[0]!.bookable).toBe(true);
    expect(offers[1]!.bookable).toBe(true);
  });

  it('sets freshness to FRESH', () => {
    expect(offers[0]!.freshness).toBe('FRESH');
  });

  it('maps price correctly for offer 1', () => {
    expect(offers[0]!.price).toBe(450.0);
  });

  it('maps currency correctly', () => {
    expect(offers[0]!.currency).toBe('USD');
  });

  it('maps cabin class to ECONOMY', () => {
    expect(offers[0]!.details['cabinClass']).toBe('ECONOMY');
  });

  it('maps nonstop flight: stops=0', () => {
    expect(offers[0]!.details['stops']).toBe(0);
  });

  it('maps connecting flight: stops=1', () => {
    expect(offers[1]!.details['stops']).toBe(1);
  });

  it('maps duration in minutes for nonstop flight (7h30m = 450 min)', () => {
    expect(offers[0]!.details['durationMinutes']).toBe(450);
  });

  it('maps duration in minutes for connecting flight (10h45m = 645 min)', () => {
    expect(offers[1]!.details['durationMinutes']).toBe(645);
  });

  it('maps validatingAirlineCodes as carrierCodes', () => {
    expect(offers[0]!.details['carrierCodes']).toEqual(['BA']);
    expect(offers[1]!.details['carrierCodes']).toEqual(['UA']);
  });

  it('sets supplierOfferId in details', () => {
    expect(offers[0]!.details['supplierOfferId']).toBe('1');
    expect(offers[1]!.details['supplierOfferId']).toBe('2');
  });

  it('sets expiresAt from lastTicketingDateTime', () => {
    const expected = new Date('2028-03-14T23:59:59Z');
    const actual = offers[0]!.expiresAt as Date;
    expect(actual.toISOString().slice(0, 16)).toBe(expected.toISOString().slice(0, 16));
  });

  it('produces a deterministic offer ID (same call = same ID)', () => {
    const offers2 = mapAmadeusOffers(multiOfferFixture, BASE_CRITERIA, DEFAULT_VALIDITY_MINUTES, NOW);
    expect(offers[0]!.id).toBe(offers2[0]!.id);
    expect(offers[1]!.id).toBe(offers2[1]!.id);
  });

  it('produces different IDs for different criteria', () => {
    const otherCriteria: FlightSearchCriteria = {
      ...BASE_CRITERIA,
      arrivalAirport: 'LAX',
    };
    const otherOffers = mapAmadeusOffers(multiOfferFixture, otherCriteria, DEFAULT_VALIDITY_MINUTES, NOW);
    expect(offers[0]!.id).not.toBe(otherOffers[0]!.id);
  });

  it('produces different IDs for offer 1 and offer 2', () => {
    expect(offers[0]!.id).not.toBe(offers[1]!.id);
  });

  it('includes a non-empty title', () => {
    expect(typeof offers[0]!.title).toBe('string');
    expect(offers[0]!.title.length).toBeGreaterThan(0);
    expect(offers[0]!.title).toContain('LHR');
    expect(offers[0]!.title).toContain('JFK');
  });
});

describe('mapAmadeusOffers — empty availability fixture', () => {
  it('returns an empty array when data is empty', () => {
    const offers = mapAmadeusOffers(emptyFixture, BASE_CRITERIA, DEFAULT_VALIDITY_MINUTES, NOW);
    expect(offers).toHaveLength(0);
  });

  it('does not throw for empty data', () => {
    expect(() =>
      mapAmadeusOffers(emptyFixture, BASE_CRITERIA, DEFAULT_VALIDITY_MINUTES, NOW),
    ).not.toThrow();
  });
});

describe('mapAmadeusOffers — expiresAt fallback', () => {
  it('falls back to now + defaultValidityMinutes when lastTicketingDate is absent', () => {
    const response = {
      data: [
        {
          id: 'no-expiry',
          itineraries: [
            {
              duration: 'PT2H',
              segments: [
                {
                  departure: { iataCode: 'LHR', at: '2028-05-01T10:00:00' },
                  arrival: { iataCode: 'CDG', at: '2028-05-01T12:00:00' },
                  carrierCode: 'BA',
                  numberOfStops: 0,
                },
              ],
            },
          ],
          price: { currency: 'EUR', total: '199.00' },
          validatingAirlineCodes: ['BA'],
          travelerPricings: [
            {
              fareDetailsBySegment: [{ cabin: 'ECONOMY' }],
            },
          ],
        },
      ],
    };

    const now = new Date('2028-03-13T10:00:00Z');
    const offers = mapAmadeusOffers(response, BASE_CRITERIA, 90, now);
    expect(offers).toHaveLength(1);

    const expectedExpiry = new Date(now.getTime() + 90 * 60_000);
    expect((offers[0]!.expiresAt as Date).getTime()).toBe(expectedExpiry.getTime());
  });
});

describe('buildSearchFingerprint', () => {
  it('returns a 16-char hex string', () => {
    const fp = buildSearchFingerprint(BASE_CRITERIA);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces identical fingerprints for identical criteria', () => {
    expect(buildSearchFingerprint(BASE_CRITERIA)).toBe(buildSearchFingerprint({ ...BASE_CRITERIA }));
  });

  it('produces different fingerprints for different origin airports', () => {
    const other: FlightSearchCriteria = { ...BASE_CRITERIA, departureAirport: 'MAN' };
    expect(buildSearchFingerprint(BASE_CRITERIA)).not.toBe(buildSearchFingerprint(other));
  });
});
