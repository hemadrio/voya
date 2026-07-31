/**
 * SearchAdapter port — the interface that route handlers depend on.
 *
 * Concrete implementations call Amadeus (flights) or RapidAPI (hotels, cars)
 * and are injected at startup.  Tests inject fakes that record calls so
 * validation tests can assert zero supplier invocations on bad input.
 */
import type { FlightSearchRequest, HotelSearchRequest, CarRentalSearchRequest, Offer } from "@travel/contracts";

export interface SearchAdapter {
  searchFlights(req: FlightSearchRequest): Promise<Offer[]>;
  searchHotels(req: HotelSearchRequest): Promise<Offer[]>;
  searchCars(req: CarRentalSearchRequest): Promise<Offer[]>;
}
