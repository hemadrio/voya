import type { NormalisedOffer } from '../../src/types.js';

export const FLIGHT_OFFER_A: NormalisedOffer = {
  offerId: 'offer-flight-a1',
  supplierName: 'AirSupplier',
  price: { amount: 199_00, currency: 'USD' },
  vertical: 'flight',
};

export const FLIGHT_OFFER_B: NormalisedOffer = {
  offerId: 'offer-flight-b1',
  supplierName: 'AirSupplier',
  price: { amount: 245_00, currency: 'USD' },
  vertical: 'flight',
};

export const HOTEL_OFFER_A: NormalisedOffer = {
  offerId: 'offer-hotel-a1',
  supplierName: 'HotelSupplier',
  price: { amount: 120_00, currency: 'USD' },
  vertical: 'hotel',
};

export const CAR_OFFER_A: NormalisedOffer = {
  offerId: 'offer-car-a1',
  supplierName: 'CarSupplier',
  price: { amount: 55_00, currency: 'USD' },
  vertical: 'car',
};

export const ALL_FLIGHT_OFFERS: ReadonlyArray<NormalisedOffer> = [
  FLIGHT_OFFER_A,
  FLIGHT_OFFER_B,
];

export const EMPTY_OFFERS: ReadonlyArray<NormalisedOffer> = [];
