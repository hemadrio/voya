import { describe, expect, it } from "vitest";
import { FlightSearchRequestSchema, HotelSearchRequestSchema, CarRentalSearchRequestSchema, OfferSchema } from "../../src/search/index.js";
import { CreateBookingRequestSchema, BookingResponseSchema, ItinerarySchema } from "../../src/booking/index.js";
import { PaymentIntentRequestSchema, PaymentIntentResponseSchema } from "../../src/payment/index.js";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
  AuthResponseSchema,
} from "../../src/auth/index.js";
import { ProfileSchema, TravelPreferencesSchema } from "../../src/user/index.js";
import {
  BookingCancellationEventSchema,
  BookingConfirmationEventSchema,
  NotificationEventSchema,
} from "../../src/events/index.js";

import flightSearchRequest from "../fixtures/search/flight-search-request.json" with { type: "json" };
import hotelSearchRequest from "../fixtures/search/hotel-search-request.json" with { type: "json" };
import carRentalSearchRequest from "../fixtures/search/car-rental-search-request.json" with { type: "json" };
import offer from "../fixtures/search/offer.json" with { type: "json" };
import createBookingRequest from "../fixtures/booking/create-booking-request.json" with { type: "json" };
import bookingResponse from "../fixtures/booking/booking-response.json" with { type: "json" };
import itinerary from "../fixtures/booking/itinerary.json" with { type: "json" };
import paymentIntentRequest from "../fixtures/payment/payment-intent-request.json" with { type: "json" };
import paymentIntentResponse from "../fixtures/payment/payment-intent-response.json" with { type: "json" };
import registerRequest from "../fixtures/auth/register-request.json" with { type: "json" };
import loginRequest from "../fixtures/auth/login-request.json" with { type: "json" };
import refreshRequest from "../fixtures/auth/refresh-request.json" with { type: "json" };
import logoutRequest from "../fixtures/auth/logout-request.json" with { type: "json" };
import oauthCallbackRequest from "../fixtures/auth/oauth-callback-request.json" with { type: "json" };
import authResponse from "../fixtures/auth/auth-response.json" with { type: "json" };
import profile from "../fixtures/user/profile.json" with { type: "json" };
import travelPreferences from "../fixtures/user/travel-preferences.json" with { type: "json" };
import bookingConfirmationEvent from "../fixtures/events/booking-confirmation-event.json" with { type: "json" };
import bookingCancellationEvent from "../fixtures/events/booking-cancellation-event.json" with { type: "json" };
import notificationEvent from "../fixtures/events/notification-event.json" with { type: "json" };

/**
 * Every committed fixture under test/fixtures must parse successfully
 * against its corresponding schema — this is the guarantee downstream
 * stories and CI rely on to develop and test without any external supplier
 * or database dependency.
 */
describe("committed fixtures parse against their schemas", () => {
  const cases: Array<[string, { safeParse: (input: unknown) => { success: boolean } }, unknown]> = [
    ["search/flight-search-request.json", FlightSearchRequestSchema, flightSearchRequest],
    ["search/hotel-search-request.json", HotelSearchRequestSchema, hotelSearchRequest],
    ["search/car-rental-search-request.json", CarRentalSearchRequestSchema, carRentalSearchRequest],
    ["search/offer.json", OfferSchema, offer],
    ["booking/create-booking-request.json", CreateBookingRequestSchema, createBookingRequest],
    ["booking/booking-response.json", BookingResponseSchema, bookingResponse],
    ["booking/itinerary.json", ItinerarySchema, itinerary],
    ["payment/payment-intent-request.json", PaymentIntentRequestSchema, paymentIntentRequest],
    ["payment/payment-intent-response.json", PaymentIntentResponseSchema, paymentIntentResponse],
    ["auth/register-request.json", RegisterRequestSchema, registerRequest],
    ["auth/login-request.json", LoginRequestSchema, loginRequest],
    ["auth/refresh-request.json", RefreshRequestSchema, refreshRequest],
    ["auth/logout-request.json", LogoutRequestSchema, logoutRequest],
    ["auth/oauth-callback-request.json", OAuthCallbackRequestSchema, oauthCallbackRequest],
    ["auth/auth-response.json", AuthResponseSchema, authResponse],
    ["user/profile.json", ProfileSchema, profile],
    ["user/travel-preferences.json", TravelPreferencesSchema, travelPreferences],
    ["events/booking-confirmation-event.json", BookingConfirmationEventSchema, bookingConfirmationEvent],
    ["events/booking-cancellation-event.json", BookingCancellationEventSchema, bookingCancellationEvent],
    ["events/notification-event.json", NotificationEventSchema, notificationEvent],
  ];

  it.each(cases)("%s parses successfully", (_name, schema, fixture) => {
    const result = schema.safeParse(fixture);
    expect(result.success).toBe(true);
  });
});
