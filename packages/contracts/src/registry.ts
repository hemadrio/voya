/**
 * Explicit schema registry — every public domain object schema listed with a
 * stable identifier.  A completeness test in test/registry.test.ts fails
 * when the set of registered IDs diverges from the committed baselines, so a
 * new schema that is not registered is caught in CI before it escapes without
 * a baseline.
 */
import type { ZodTypeAny } from "zod";
import { FlightSearchRequestSchema } from "./search/flight.js";
import { HotelSearchRequestSchema } from "./search/hotel.js";
import { CarRentalSearchRequestSchema } from "./search/car.js";
import { OfferSchema } from "./search/offer.js";
import { PassengerInfoSchema } from "./booking/passenger.js";
import { CreateBookingRequestSchema } from "./booking/request.js";
import { BookingResponseSchema, ItinerarySchema } from "./booking/response.js";
import { PaymentIntentRequestSchema, PaymentIntentResponseSchema } from "./payment/index.js";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
  AuthResponseSchema,
} from "./auth/index.js";
import { ProfileSchema, TravelPreferencesSchema } from "./user/index.js";
import {
  BookingConfirmationEventSchema,
  BookingCancellationEventSchema,
  NotificationEventSchema,
  QueueMessageEnvelopeSchema,
} from "./events/index.js";
import { ErrorDetailSchema, ErrorEnvelopeSchema } from "./errors/envelope.js";
import {
  ProfilePatchSchema,
  ExportAcceptedSchema,
  ExportStatusSchema,
  ExportArchiveManifestSchema,
  ErasureRequestSchema,
  ErasureAcceptedSchema,
  DataSubjectRequestSchema,
} from "./privacy/index.js";

export const SCHEMA_REGISTRY: Readonly<Record<string, ZodTypeAny>> = {
  "search.FlightSearchRequest": FlightSearchRequestSchema,
  "search.HotelSearchRequest": HotelSearchRequestSchema,
  "search.CarRentalSearchRequest": CarRentalSearchRequestSchema,
  "search.Offer": OfferSchema,
  "booking.PassengerInfo": PassengerInfoSchema,
  "booking.CreateBookingRequest": CreateBookingRequestSchema,
  "booking.BookingResponse": BookingResponseSchema,
  "booking.Itinerary": ItinerarySchema,
  "payment.PaymentIntentRequest": PaymentIntentRequestSchema,
  "payment.PaymentIntentResponse": PaymentIntentResponseSchema,
  "auth.RegisterRequest": RegisterRequestSchema,
  "auth.LoginRequest": LoginRequestSchema,
  "auth.RefreshRequest": RefreshRequestSchema,
  "auth.LogoutRequest": LogoutRequestSchema,
  "auth.OAuthCallbackRequest": OAuthCallbackRequestSchema,
  "auth.AuthResponse": AuthResponseSchema,
  "user.Profile": ProfileSchema,
  "user.TravelPreferences": TravelPreferencesSchema,
  "events.BookingConfirmationEvent": BookingConfirmationEventSchema,
  "events.BookingCancellationEvent": BookingCancellationEventSchema,
  "events.NotificationEvent": NotificationEventSchema,
  "events.QueueMessageEnvelope": QueueMessageEnvelopeSchema,
  "errors.ErrorDetail": ErrorDetailSchema,
  "errors.ErrorEnvelope": ErrorEnvelopeSchema,
  "privacy.ProfilePatch": ProfilePatchSchema,
  "privacy.ExportAccepted": ExportAcceptedSchema,
  "privacy.ExportStatus": ExportStatusSchema,
  "privacy.ExportArchiveManifest": ExportArchiveManifestSchema,
  "privacy.ErasureRequest": ErasureRequestSchema,
  "privacy.ErasureAccepted": ErasureAcceptedSchema,
  "privacy.DataSubjectRequest": DataSubjectRequestSchema,
};

export const SCHEMA_IDS: ReadonlyArray<string> = Object.keys(SCHEMA_REGISTRY).sort();
