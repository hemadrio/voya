export { PassengerInfoSchema, NAME_REQUIRED_MESSAGE, PASSENGER_EMAIL_INVALID_MESSAGE } from "./passenger.js";
export type { PassengerInfo } from "./passenger.js";

export {
  CreateBookingRequestSchema,
  PASSENGERS_REQUIRED_MESSAGE,
  CONTACT_EMAIL_INVALID_MESSAGE,
} from "./request.js";
export type { CreateBookingRequest } from "./request.js";

export { BookingResponseSchema, ItinerarySchema } from "./response.js";
export type { BookingResponse, Itinerary } from "./response.js";
