/**
 * OpenAPI 3.1 operation registry for all v1 routes.
 *
 * Every public route must be registered here with its request schema,
 * response schemas, tags, and authentication requirement. A route that is
 * not registered will cause the drift-check pipeline step to fail because
 * the committed openapi.yaml will not match the regenerated output once the
 * route is added.
 *
 * Guest-allowed routes (search, chat) set `auth: false`.  All others default
 * to requiring bearer or cookie session authentication.
 */
import type { ZodTypeAny } from "zod";
import { z } from "zod";

// ── Auth ───────────────────────────────────────────────────────────────────
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
  AuthResponseSchema,
} from "../auth/index.js";

// ── Search ─────────────────────────────────────────────────────────────────
import { FlightSearchRequestSchema } from "../search/flight.js";
import { HotelSearchRequestSchema } from "../search/hotel.js";
import { CarRentalSearchRequestSchema } from "../search/car.js";
import { OfferSchema } from "../search/offer.js";

// ── Booking ────────────────────────────────────────────────────────────────
import { CreateBookingRequestSchema } from "../booking/request.js";
import { BookingResponseSchema, ItinerarySchema } from "../booking/response.js";

// ── Payment ────────────────────────────────────────────────────────────────
import { PaymentIntentRequestSchema, PaymentIntentResponseSchema } from "../payment/index.js";

// ── User ───────────────────────────────────────────────────────────────────
import { ProfileSchema, TravelPreferencesSchema } from "../user/index.js";

// ── Error envelope (shared component) ──────────────────────────────────────
import { ErrorEnvelopeSchema } from "../errors/envelope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PathParam {
  name: string;
  description: string;
  schema: { type: string; format?: string };
}

export interface QueryParam {
  name: string;
  required: boolean;
  description: string;
  schema: { type: string; format?: string; minimum?: number };
}

export interface OperationResponse {
  description: string;
  /** Zod schema for the success body (absent for 204 or error-only responses) */
  schema?: ZodTypeAny;
  /** Pass true to indicate an array response body */
  isArray?: boolean;
}

export interface OperationDef {
  operationId: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tags: string[];
  summary: string;
  /**
   * false = guest-allowed (no bearer/cookie required).
   * true  = requires bearerAccessToken OR sessionCookie.
   */
  auth: boolean;
  pathParams?: PathParam[];
  queryParams?: QueryParam[];
  requestBody?: {
    schema: ZodTypeAny;
    required: boolean;
    /** Override content-type (default: application/json) */
    contentType?: string;
    description?: string;
  };
  /** HTTP 2xx success response */
  successResponse: OperationResponse & { statusCode: number };
}

// ---------------------------------------------------------------------------
// Chat request (not in @travel/contracts yet — inline minimal schema)
// ---------------------------------------------------------------------------

const ChatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1),
  })
  .strict();

const ChatRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1),
    sessionId: z.string().trim().min(1).optional(),
  })
  .strict();

const ChatResponseSchema = z
  .object({
    message: z.string(),
    sessionId: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared ID path param
// ---------------------------------------------------------------------------

const idPathParam: PathParam = {
  name: "id",
  description: "Resource identifier",
  schema: { type: "string" },
};

// ---------------------------------------------------------------------------
// Operation registry
// ---------------------------------------------------------------------------

export const OPERATIONS: OperationDef[] = [
  // ── Auth ─────────────────────────────────────────────────────────────
  {
    operationId: "registerUser",
    method: "post",
    path: "/v1/auth/register",
    tags: ["auth"],
    summary: "Register a new traveler account with email and password",
    auth: false,
    requestBody: { schema: RegisterRequestSchema, required: true },
    successResponse: { statusCode: 201, description: "Account created; session tokens returned", schema: AuthResponseSchema },
  },
  {
    operationId: "loginUser",
    method: "post",
    path: "/v1/auth/login",
    tags: ["auth"],
    summary: "Authenticate with email and password; receive access and refresh tokens",
    auth: false,
    requestBody: { schema: LoginRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Authentication successful", schema: AuthResponseSchema },
  },
  {
    operationId: "refreshToken",
    method: "post",
    path: "/v1/auth/refresh",
    tags: ["auth"],
    summary: "Rotate the refresh token and receive a new access token",
    auth: false,
    requestBody: { schema: RefreshRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Token rotated successfully", schema: AuthResponseSchema },
  },
  {
    operationId: "logoutUser",
    method: "post",
    path: "/v1/auth/logout",
    tags: ["auth"],
    summary: "Revoke the current session",
    auth: true,
    requestBody: { schema: LogoutRequestSchema, required: true },
    successResponse: { statusCode: 204, description: "Session revoked" },
  },
  {
    operationId: "oauthGoogleCallback",
    method: "post",
    path: "/v1/auth/google/callback",
    tags: ["auth"],
    summary: "Exchange a Google OAuth2 authorization code for platform session tokens",
    auth: false,
    requestBody: { schema: OAuthCallbackRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Google OAuth authentication successful", schema: AuthResponseSchema },
  },

  // ── Search (guest-allowed) ────────────────────────────────────────────
  {
    operationId: "searchFlights",
    method: "post",
    path: "/v1/flights/search",
    tags: ["search", "flights"],
    summary: "Search for available flight offers across all configured suppliers",
    auth: false,
    requestBody: { schema: FlightSearchRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Ranked flight offers", schema: OfferSchema, isArray: true },
  },
  {
    operationId: "searchHotels",
    method: "post",
    path: "/v1/hotels/search",
    tags: ["search", "hotels"],
    summary: "Search for available hotel offers across all configured suppliers",
    auth: false,
    requestBody: { schema: HotelSearchRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Ranked hotel offers", schema: OfferSchema, isArray: true },
  },
  {
    operationId: "searchCars",
    method: "post",
    path: "/v1/cars/search",
    tags: ["search", "cars"],
    summary: "Search for available car rental offers across all configured suppliers",
    auth: false,
    requestBody: { schema: CarRentalSearchRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "Ranked car rental offers", schema: OfferSchema, isArray: true },
  },

  // ── Users ─────────────────────────────────────────────────────────────
  {
    operationId: "getMyProfile",
    method: "get",
    path: "/v1/users/me",
    tags: ["users"],
    summary: "Get the authenticated traveler's profile",
    auth: true,
    successResponse: { statusCode: 200, description: "Traveler profile", schema: ProfileSchema },
  },
  {
    operationId: "updateMyProfile",
    method: "patch",
    path: "/v1/users/me",
    tags: ["users"],
    summary: "Update the authenticated traveler's profile",
    auth: true,
    requestBody: { schema: ProfileSchema, required: true },
    successResponse: { statusCode: 200, description: "Updated traveler profile", schema: ProfileSchema },
  },
  {
    operationId: "getMyPreferences",
    method: "get",
    path: "/v1/users/me/preferences",
    tags: ["users"],
    summary: "Get the authenticated traveler's travel preferences",
    auth: true,
    successResponse: { statusCode: 200, description: "Travel preferences", schema: TravelPreferencesSchema },
  },
  {
    operationId: "updateMyPreferences",
    method: "patch",
    path: "/v1/users/me/preferences",
    tags: ["users"],
    summary: "Update the authenticated traveler's travel preferences",
    auth: true,
    requestBody: { schema: TravelPreferencesSchema, required: true },
    successResponse: { statusCode: 200, description: "Updated travel preferences", schema: TravelPreferencesSchema },
  },

  // ── Bookings ──────────────────────────────────────────────────────────
  {
    operationId: "createBooking",
    method: "post",
    path: "/v1/bookings",
    tags: ["bookings"],
    summary: "Create a PENDING booking for a validated offer; initiates the checkout saga",
    auth: true,
    requestBody: { schema: CreateBookingRequestSchema, required: true },
    successResponse: { statusCode: 201, description: "Booking created in PENDING state", schema: BookingResponseSchema },
  },
  {
    operationId: "listBookings",
    method: "get",
    path: "/v1/bookings",
    tags: ["bookings"],
    summary: "List all bookings for the authenticated traveler",
    auth: true,
    queryParams: [
      { name: "page", required: false, description: "Page number (1-based)", schema: { type: "integer", minimum: 1 } },
      { name: "pageSize", required: false, description: "Items per page (max 100)", schema: { type: "integer", minimum: 1 } },
    ],
    successResponse: { statusCode: 200, description: "Paginated list of bookings", schema: BookingResponseSchema, isArray: true },
  },
  {
    operationId: "getBooking",
    method: "get",
    path: "/v1/bookings/{id}",
    tags: ["bookings"],
    summary: "Get a single booking by ID (must be owned by the authenticated traveler)",
    auth: true,
    pathParams: [idPathParam],
    successResponse: { statusCode: 200, description: "Booking detail", schema: BookingResponseSchema },
  },
  {
    operationId: "cancelBooking",
    method: "delete",
    path: "/v1/bookings/{id}",
    tags: ["bookings"],
    summary: "Cancel a booking; initiates the cancellation and refund saga",
    auth: true,
    pathParams: [idPathParam],
    successResponse: { statusCode: 200, description: "Booking cancelled", schema: BookingResponseSchema },
  },

  // ── Itineraries ───────────────────────────────────────────────────────
  {
    operationId: "listItineraries",
    method: "get",
    path: "/v1/itineraries",
    tags: ["itineraries"],
    summary: "List all itineraries for the authenticated traveler",
    auth: true,
    successResponse: { statusCode: 200, description: "List of itineraries", schema: ItinerarySchema, isArray: true },
  },
  {
    operationId: "getItinerary",
    method: "get",
    path: "/v1/itineraries/{id}",
    tags: ["itineraries"],
    summary: "Get a single itinerary by ID (must be owned by the authenticated traveler)",
    auth: true,
    pathParams: [idPathParam],
    successResponse: { statusCode: 200, description: "Itinerary detail with all bookings", schema: ItinerarySchema },
  },

  // ── Payments ──────────────────────────────────────────────────────────
  {
    operationId: "createPaymentIntent",
    method: "post",
    path: "/v1/payments/intents",
    tags: ["payments"],
    summary: "Create a Stripe PaymentIntent for a PENDING booking; returns clientSecret for Stripe-hosted card entry",
    auth: true,
    requestBody: { schema: PaymentIntentRequestSchema, required: true },
    successResponse: { statusCode: 201, description: "PaymentIntent created; clientSecret returned", schema: PaymentIntentResponseSchema },
  },
  {
    operationId: "stripeWebhook",
    method: "post",
    path: "/v1/payments/webhook",
    tags: ["payments"],
    summary: "Stripe webhook endpoint — raw body required for HMAC signature verification",
    auth: false,
    requestBody: {
      schema: z.object({ type: z.string(), data: z.record(z.unknown()) }).strict(),
      required: true,
      contentType: "application/octet-stream",
      description: "Raw Stripe webhook payload. Must be the unmodified request body as received; JSON parsing before this handler invalidates the HMAC signature.",
    },
    successResponse: { statusCode: 200, description: "Webhook received and enqueued for processing" },
  },

  // ── Chat (guest-allowed) ──────────────────────────────────────────────
  {
    operationId: "startChat",
    method: "post",
    path: "/v1/chat",
    tags: ["chat"],
    summary: "Start or continue a conversational planning session (Server-Sent Events stream)",
    auth: false,
    requestBody: { schema: ChatRequestSchema, required: true },
    successResponse: { statusCode: 200, description: "SSE token stream from the AI planner", schema: ChatResponseSchema },
  },
];

export { ErrorEnvelopeSchema };
