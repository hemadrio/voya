export {
  FlightSearchRequestSchema,
  FUTURE_DEPARTURE_DATE_MESSAGE,
  RETURN_DATE_NOT_BEFORE_DEPARTURE_MESSAGE,
  PASSENGER_COUNT_MESSAGE,
} from "./flight.js";
export type { FlightSearchRequest } from "./flight.js";

export {
  HotelSearchRequestSchema,
  LOCATION_REQUIRED_MESSAGE,
  CHECK_OUT_AFTER_CHECK_IN_MESSAGE,
  GUEST_COUNT_MESSAGE,
} from "./hotel.js";
export type { HotelSearchRequest } from "./hotel.js";

export {
  CarRentalSearchRequestSchema,
  PICKUP_LOCATION_REQUIRED_MESSAGE,
  DROPOFF_LOCATION_REQUIRED_MESSAGE,
  FUTURE_PICKUP_DATE_MESSAGE,
  DROPOFF_AFTER_PICKUP_MESSAGE,
} from "./car.js";
export type { CarRentalSearchRequest } from "./car.js";

export { OfferSchema, ILLUSTRATIVE_NOT_BOOKABLE_MESSAGE } from "./offer.js";
export type { Offer } from "./offer.js";
