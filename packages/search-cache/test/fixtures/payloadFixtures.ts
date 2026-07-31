import type { CachedSearchPayload } from '../../src/types.js';
import { SCHEMA_VERSION } from '../../src/types.js';

export const BASE_GENERATED_AT = 1_700_000_000_000; // fixed epoch ms for test reproducibility

export const FLIGHT_SEARCH_PARAMS = {
  origin: 'JFK',
  destination: 'LAX',
  departureDate: '2024-03-15',
  returnDate: '2024-03-22',
  passengers: 1,
  cabin: 'ECONOMY',
};

/** Params with different case / whitespace — must produce the SAME key as FLIGHT_SEARCH_PARAMS */
export const FLIGHT_SEARCH_PARAMS_EQUIV = {
  destination: ' lax ',       // extra spaces, lowercase
  origin: 'jfk',              // lowercase
  cabin: 'economy',           // lowercase
  passengers: 1,
  departureDate: '2024-03-15',
  returnDate: '2024-03-22',
};

/** Params that differ meaningfully — must produce a DIFFERENT key */
export const FLIGHT_SEARCH_PARAMS_DIFFERENT = {
  origin: 'JFK',
  destination: 'SFO',         // different destination
  departureDate: '2024-03-15',
  returnDate: '2024-03-22',
  passengers: 1,
  cabin: 'ECONOMY',
};

export const HOTEL_SEARCH_PARAMS = {
  locationCode: 'NYC',
  checkIn: '2024-03-15',
  checkOut: '2024-03-20',
  guests: 2,
  rooms: 1,
};

export const CAR_SEARCH_PARAMS = {
  pickupLocation: 'LAX',
  dropoffLocation: 'LAX',
  pickupDate: '2024-03-15',
  dropoffDate: '2024-03-20',
  driverAge: 30,
};

export function makeFlightPayload(
  generatedAt = BASE_GENERATED_AT,
  offerCount = 2,
): CachedSearchPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    offers: Array.from({ length: offerCount }, (_, i) => ({
      offerId: `offer-flight-${i + 1}`,
      supplierName: 'AirSupplier',
      price: { amount: 199_00 + i * 10_00, currency: 'USD' },
      vertical: 'flight',
    })),
    supplierOutcomes: [
      { supplier: 'AirSupplier', outcome: 'SUCCEEDED' },
    ],
  };
}

export function makeHotelPayload(generatedAt = BASE_GENERATED_AT): CachedSearchPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    offers: [
      { offerId: 'offer-hotel-1', supplierName: 'HotelSupplier', price: { amount: 120_00, currency: 'USD' }, vertical: 'hotel' },
    ],
    supplierOutcomes: [{ supplier: 'HotelSupplier', outcome: 'SUCCEEDED' }],
  };
}

export function makePayloadWithVersion(schemaVersion: number): CachedSearchPayload {
  return {
    schemaVersion,
    generatedAt: BASE_GENERATED_AT,
    offers: [],
    supplierOutcomes: [],
  };
}
