#!/usr/bin/env node
/**
 * Bootstrap-only helper: generates docs/api/openapi.yaml using pre-computed
 * JSON Schema objects without requiring Zod or any other dependency.
 *
 * This file exists only to produce the initial committed openapi.yaml when
 * the workspace dependencies are not yet installed. In CI the real generator
 * (scripts/generate-openapi.ts) is used because Zod is available.
 *
 * The schema representations here must match what scripts/generate-openapi.ts
 * produces when run with Zod installed.
 */

const { writeFileSync, mkdirSync } = require("fs");
const { resolve, dirname } = require("path");

const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "docs/api/openapi.yaml");

// ── Reusable schema fragments ────────────────────────────────────────────────

const S = {
  str: { type: "string" },
  strMin1: { minLength: 1, type: "string" },
  bool: { type: "boolean" },
  email: { format: "email", type: "string" },
  dateTime: { format: "date-time", type: "string" },
  iata: { pattern: "^[A-Z]{3}$", type: "string" },
  currency: { pattern: "^[A-Z]{3}$", type: "string" },
  money: { oneOf: [{ type: "string" }, { type: "number" }] },
  bookingStatus: { enum: ["CANCELLED", "CONFIRMED", "EXPIRED", "FAILED", "PENDING", "REFUNDED"], type: "string" },
  bookingType: { enum: ["CAR", "FLIGHT", "HOTEL"], type: "string" },
  seatClass: { enum: ["BUSINESS", "ECONOMY", "FIRST"], type: "string" },
  carClass: { enum: ["COMPACT", "ECONOMY", "MIDSIZE", "PREMIUM"], type: "string" },
  provenance: { enum: ["AMADEUS", "ILLUSTRATIVE", "RAPIDAPI"], type: "string" },
  freshness: { enum: ["FRESH", "STALE"], type: "string" },
  paymentStatus: { enum: ["FAILED", "PROCESSING", "REFUNDED", "REQUIRES_PAYMENT_METHOD", "SUCCEEDED"], type: "string" },
  role: { enum: ["support_agent", "system", "traveler"], type: "string" },
  hotelStarRating: { oneOf: [{ const: 3 }, { const: 4 }, { const: 5 }] },
};

// ── Component schemas ────────────────────────────────────────────────────────

const PassengerInfoSchema = {
  additionalProperties: false,
  properties: {
    dateOfBirth: S.dateTime,
    email: S.email,
    firstName: S.strMin1,
    lastName: S.strMin1,
    passportNumber: S.strMin1,
  },
  required: ["dateOfBirth", "firstName", "lastName"],
  type: "object",
};

const BookingResponseSchema = {
  additionalProperties: false,
  properties: {
    bookingType: S.bookingType,
    createdAt: S.dateTime,
    currency: S.currency,
    id: S.strMin1,
    offerId: S.strMin1,
    passengers: { items: PassengerInfoSchema, type: "array" },
    status: S.bookingStatus,
    totalPrice: S.money,
    updatedAt: S.dateTime,
  },
  required: ["bookingType", "createdAt", "currency", "id", "offerId", "passengers", "status", "totalPrice", "updatedAt"],
  type: "object",
};

const SCHEMAS = {
  AuthResponse: {
    additionalProperties: false,
    properties: {
      accessToken: S.strMin1,
      expiresIn: { exclusiveMinimum: 0, type: "integer" },
    },
    required: ["accessToken", "expiresIn"],
    type: "object",
  },
  BookingResponse: BookingResponseSchema,
  CarRentalSearchRequest: {
    additionalProperties: false,
    properties: {
      carClass: S.carClass,
      currency: S.currency,
      dropoffDate: S.dateTime,
      dropoffLocation: S.strMin1,
      pickupDate: S.dateTime,
      pickupLocation: S.strMin1,
    },
    required: ["carClass", "currency", "dropoffDate", "dropoffLocation", "pickupDate", "pickupLocation"],
    type: "object",
  },
  CreateBookingRequest: {
    additionalProperties: false,
    properties: {
      bookingType: S.bookingType,
      contactEmail: S.email,
      contactPhone: S.strMin1,
      currency: S.currency,
      idempotencyKey: S.strMin1,
      offerId: S.strMin1,
      offerPrice: S.money,
      passengers: { items: PassengerInfoSchema, type: "array" },
    },
    required: ["bookingType", "contactEmail", "currency", "idempotencyKey", "offerId", "offerPrice", "passengers"],
    type: "object",
  },
  FlightSearchRequest: {
    additionalProperties: false,
    properties: {
      arrivalAirport: S.iata,
      currency: S.currency,
      departureAirport: S.iata,
      departureDate: S.dateTime,
      passengers: { maximum: 9, minimum: 1, type: "integer" },
      returnDate: S.dateTime,
      seatClass: S.seatClass,
    },
    required: ["arrivalAirport", "currency", "departureAirport", "departureDate", "passengers", "seatClass"],
    type: "object",
  },
  HotelSearchRequest: {
    additionalProperties: false,
    properties: {
      checkInDate: S.dateTime,
      checkOutDate: S.dateTime,
      currency: S.currency,
      guests: { minimum: 1, type: "integer" },
      location: S.strMin1,
      starRating: S.hotelStarRating,
    },
    required: ["checkInDate", "checkOutDate", "currency", "guests", "location"],
    type: "object",
  },
  Itinerary: {
    additionalProperties: false,
    properties: {
      bookings: { items: BookingResponseSchema, type: "array" },
      createdAt: S.dateTime,
      id: S.strMin1,
      updatedAt: S.dateTime,
      userId: S.strMin1,
    },
    required: ["bookings", "createdAt", "id", "updatedAt", "userId"],
    type: "object",
  },
  Offer: {
    additionalProperties: false,
    properties: {
      bookable: S.bool,
      currency: S.currency,
      details: { additionalProperties: {}, type: "object" },
      expiresAt: S.dateTime,
      freshness: S.freshness,
      id: S.strMin1,
      price: S.money,
      provenance: S.provenance,
      rating: { maximum: 5, minimum: 0, type: "number" },
      reviews: { minimum: 0, type: "integer" },
      title: S.strMin1,
    },
    required: ["bookable", "currency", "details", "expiresAt", "freshness", "id", "price", "provenance", "title"],
    type: "object",
  },
  PaymentIntentRequest: {
    additionalProperties: false,
    properties: {
      amount: S.money,
      bookingId: S.strMin1,
      currency: S.currency,
      idempotencyKey: S.strMin1,
      paymentMethodId: S.strMin1,
    },
    required: ["amount", "bookingId", "currency", "idempotencyKey"],
    type: "object",
  },
  PaymentIntentResponse: {
    additionalProperties: false,
    properties: {
      amount: S.money,
      bookingId: S.strMin1,
      clientSecret: S.strMin1,
      currency: S.currency,
      id: S.strMin1,
      status: S.paymentStatus,
    },
    required: ["amount", "bookingId", "clientSecret", "currency", "id", "status"],
    type: "object",
  },
  Profile: {
    additionalProperties: false,
    properties: {
      createdAt: S.dateTime,
      email: S.email,
      firstName: S.strMin1,
      id: S.strMin1,
      lastName: S.strMin1,
      role: S.role,
    },
    required: ["createdAt", "email", "firstName", "id", "lastName", "role"],
    type: "object",
  },
  RegisterRequest: {
    additionalProperties: false,
    properties: {
      email: S.email,
      firstName: S.strMin1,
      lastName: S.strMin1,
      password: { minLength: 8, pattern: "(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)", type: "string" },
    },
    required: ["email", "firstName", "lastName", "password"],
    type: "object",
  },
  LoginRequest: {
    additionalProperties: false,
    properties: {
      email: S.email,
      password: S.strMin1,
    },
    required: ["email", "password"],
    type: "object",
  },
  RefreshRequest: {
    additionalProperties: false,
    properties: { refreshToken: S.strMin1 },
    required: ["refreshToken"],
    type: "object",
  },
  LogoutRequest: {
    additionalProperties: false,
    properties: { refreshToken: S.strMin1 },
    required: ["refreshToken"],
    type: "object",
  },
  OAuthCallbackRequest: {
    additionalProperties: false,
    properties: {
      code: S.strMin1,
      state: S.strMin1,
    },
    required: ["code", "state"],
    type: "object",
  },
  TravelPreferences: {
    additionalProperties: false,
    properties: {
      dietaryRestrictions: { items: S.strMin1, type: "array" },
      preferredAirlines: { items: S.strMin1, type: "array" },
      preferredCurrency: S.currency,
      preferredSeatClass: S.seatClass,
      userId: S.strMin1,
    },
    required: ["userId"],
    type: "object",
  },
  ChatRequest: {
    additionalProperties: false,
    properties: {
      messages: {
        items: {
          additionalProperties: false,
          properties: {
            content: S.strMin1,
            role: { enum: ["assistant", "user"], type: "string" },
          },
          required: ["content", "role"],
          type: "object",
        },
        type: "array",
      },
      sessionId: S.strMin1,
    },
    required: ["messages"],
    type: "object",
  },
  ChatResponse: {
    additionalProperties: false,
    properties: {
      message: S.str,
      sessionId: S.str,
    },
    required: ["message", "sessionId"],
    type: "object",
  },
  WebhookRequest: {
    additionalProperties: false,
    properties: {
      data: { additionalProperties: {}, type: "object" },
      type: S.str,
    },
    required: ["data", "type"],
    type: "object",
  },
};

const ErrorEnvelopeSchema = {
  additionalProperties: false,
  description:
    "Platform-wide error envelope. The `reference` field equals the active X-Ray trace " +
    "identifier so a traveler screenshot resolves directly to a trace. " +
    "Present on all 4xx and 5xx responses.",
  properties: {
    error: {
      additionalProperties: false,
      properties: {
        code: S.str,
        field: S.str,
        message: S.str,
      },
      required: ["code", "message"],
      type: "object",
    },
    reference: S.strMin1,
  },
  required: ["error", "reference"],
  type: "object",
};

// ── Error response components ────────────────────────────────────────────────

const errRef = { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } };

const ERROR_RESPONSES = {
  Forbidden: { content: errRef, description: "Authenticated user does not own this resource" },
  LifecycleConflict: { content: errRef, description: "The requested state transition is not permitted from the current booking status" },
  NotFound: { content: errRef, description: "Resource not found" },
  RateLimited: {
    content: errRef,
    description: "Too many requests — see Retry-After header",
    headers: {
      "Retry-After": { description: "Seconds until the rate limit resets", schema: { type: "integer" } },
    },
  },
  SupplierRejected: { content: errRef, description: "The upstream supplier rejected the booking or payment — re-consent or retry required" },
  SupplierTimeout: { content: errRef, description: "Upstream supplier did not respond within the configured timeout" },
  SupplierUnavailable: { content: errRef, description: "Upstream supplier returned an unexpected error (5xx or timeout)" },
  Unauthenticated: { content: errRef, description: "Missing or invalid access token or session cookie" },
  ValidationFailed: {
    content: {
      "application/json": {
        example: {
          error: { code: "VALIDATION_FAILED", field: "origin", message: "Airport code must be a valid 3-letter IATA code" },
          reference: "01j3h4k-7f2a9b",
        },
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
      },
    },
    description: "Request body or query parameters failed Zod schema validation",
  },
};

// ── Fixed error responses for every operation ────────────────────────────────

const STD_ERRORS = {
  "400": { $ref: "#/components/responses/ValidationFailed" },
  "401": { $ref: "#/components/responses/Unauthenticated" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/LifecycleConflict" },
  "422": { $ref: "#/components/responses/SupplierRejected" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "502": { $ref: "#/components/responses/SupplierUnavailable" },
  "504": { $ref: "#/components/responses/SupplierTimeout" },
};

const AUTH_SEC = [{ bearerAccessToken: [] }, { sessionCookie: [] }];
const NO_AUTH = [];

function ok(desc, schema, isArray) {
  const body = { description: desc };
  if (schema) {
    body.content = { "application/json": { schema: isArray ? { items: schema, type: "array" } : schema } };
  }
  return body;
}

function rb(schema, req, ct, desc) {
  const r = { content: { [ct || "application/json"]: { schema } }, required: req };
  if (desc) r.description = desc;
  return r;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const PATHS = {
  "/v1/auth/google/callback": {
    post: {
      operationId: "oauthGoogleCallback",
      requestBody: rb(SCHEMAS.OAuthCallbackRequest, true),
      responses: { "200": ok("Google OAuth authentication successful", SCHEMAS.AuthResponse), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Exchange a Google OAuth2 authorization code for platform session tokens",
      tags: ["auth"],
    },
  },
  "/v1/auth/login": {
    post: {
      operationId: "loginUser",
      requestBody: rb(SCHEMAS.LoginRequest, true),
      responses: { "200": ok("Authentication successful", SCHEMAS.AuthResponse), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Authenticate with email and password; receive access and refresh tokens",
      tags: ["auth"],
    },
  },
  "/v1/auth/logout": {
    post: {
      operationId: "logoutUser",
      requestBody: rb(SCHEMAS.LogoutRequest, true),
      responses: { "204": ok("Session revoked"), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Revoke the current session",
      tags: ["auth"],
    },
  },
  "/v1/auth/refresh": {
    post: {
      operationId: "refreshToken",
      requestBody: rb(SCHEMAS.RefreshRequest, true),
      responses: { "200": ok("Token rotated successfully", SCHEMAS.AuthResponse), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Rotate the refresh token and receive a new access token",
      tags: ["auth"],
    },
  },
  "/v1/auth/register": {
    post: {
      operationId: "registerUser",
      requestBody: rb(SCHEMAS.RegisterRequest, true),
      responses: { "201": ok("Account created; session tokens returned", SCHEMAS.AuthResponse), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Register a new traveler account with email and password",
      tags: ["auth"],
    },
  },
  "/v1/bookings": {
    get: {
      operationId: "listBookings",
      parameters: [
        { description: "Page number (1-based)", in: "query", name: "page", required: false, schema: { minimum: 1, type: "integer" } },
        { description: "Items per page (max 100)", in: "query", name: "pageSize", required: false, schema: { minimum: 1, type: "integer" } },
      ],
      responses: { "200": ok("Paginated list of bookings", SCHEMAS.BookingResponse, true), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "List all bookings for the authenticated traveler",
      tags: ["bookings"],
    },
    post: {
      operationId: "createBooking",
      requestBody: rb(SCHEMAS.CreateBookingRequest, true),
      responses: { "201": ok("Booking created in PENDING state", SCHEMAS.BookingResponse), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Create a PENDING booking for a validated offer; initiates the checkout saga",
      tags: ["bookings"],
    },
  },
  "/v1/bookings/{id}": {
    delete: {
      operationId: "cancelBooking",
      parameters: [{ description: "Resource identifier", in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { "200": ok("Booking cancelled", SCHEMAS.BookingResponse), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Cancel a booking; initiates the cancellation and refund saga",
      tags: ["bookings"],
    },
    get: {
      operationId: "getBooking",
      parameters: [{ description: "Resource identifier", in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { "200": ok("Booking detail", SCHEMAS.BookingResponse), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Get a single booking by ID (must be owned by the authenticated traveler)",
      tags: ["bookings"],
    },
  },
  "/v1/cars/search": {
    post: {
      operationId: "searchCars",
      requestBody: rb(SCHEMAS.CarRentalSearchRequest, true),
      responses: { "200": ok("Ranked car rental offers", SCHEMAS.Offer, true), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Search for available car rental offers across all configured suppliers",
      tags: ["search", "cars"],
    },
  },
  "/v1/chat": {
    post: {
      operationId: "startChat",
      requestBody: rb(SCHEMAS.ChatRequest, true),
      responses: { "200": ok("SSE token stream from the AI planner", SCHEMAS.ChatResponse), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Start or continue a conversational planning session (Server-Sent Events stream)",
      tags: ["chat"],
    },
  },
  "/v1/flights/search": {
    post: {
      operationId: "searchFlights",
      requestBody: rb(SCHEMAS.FlightSearchRequest, true),
      responses: { "200": ok("Ranked flight offers", SCHEMAS.Offer, true), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Search for available flight offers across all configured suppliers",
      tags: ["search", "flights"],
    },
  },
  "/v1/hotels/search": {
    post: {
      operationId: "searchHotels",
      requestBody: rb(SCHEMAS.HotelSearchRequest, true),
      responses: { "200": ok("Ranked hotel offers", SCHEMAS.Offer, true), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Search for available hotel offers across all configured suppliers",
      tags: ["search", "hotels"],
    },
  },
  "/v1/itineraries": {
    get: {
      operationId: "listItineraries",
      responses: { "200": ok("List of itineraries", SCHEMAS.Itinerary, true), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "List all itineraries for the authenticated traveler",
      tags: ["itineraries"],
    },
  },
  "/v1/itineraries/{id}": {
    get: {
      operationId: "getItinerary",
      parameters: [{ description: "Resource identifier", in: "path", name: "id", required: true, schema: { type: "string" } }],
      responses: { "200": ok("Itinerary detail with all bookings", SCHEMAS.Itinerary), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Get a single itinerary by ID (must be owned by the authenticated traveler)",
      tags: ["itineraries"],
    },
  },
  "/v1/payments/intents": {
    post: {
      operationId: "createPaymentIntent",
      requestBody: rb(SCHEMAS.PaymentIntentRequest, true),
      responses: { "201": ok("PaymentIntent created; clientSecret returned", SCHEMAS.PaymentIntentResponse), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Create a Stripe PaymentIntent for a PENDING booking; returns clientSecret for Stripe-hosted card entry",
      tags: ["payments"],
    },
  },
  "/v1/payments/webhook": {
    post: {
      operationId: "stripeWebhook",
      requestBody: rb(
        SCHEMAS.WebhookRequest,
        true,
        "application/octet-stream",
        "Raw Stripe webhook payload. Must be the unmodified request body as received; JSON parsing before this handler invalidates the HMAC signature.",
      ),
      responses: { "200": ok("Webhook received and enqueued for processing"), ...STD_ERRORS },
      security: NO_AUTH,
      summary: "Stripe webhook endpoint — raw body required for HMAC signature verification",
      tags: ["payments"],
    },
  },
  "/v1/users/me": {
    get: {
      operationId: "getMyProfile",
      responses: { "200": ok("Traveler profile", SCHEMAS.Profile), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Get the authenticated traveler's profile",
      tags: ["users"],
    },
    patch: {
      operationId: "updateMyProfile",
      requestBody: rb(SCHEMAS.Profile, true),
      responses: { "200": ok("Updated traveler profile", SCHEMAS.Profile), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Update the authenticated traveler's profile",
      tags: ["users"],
    },
  },
  "/v1/users/me/preferences": {
    get: {
      operationId: "getMyPreferences",
      responses: { "200": ok("Travel preferences", SCHEMAS.TravelPreferences), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Get the authenticated traveler's travel preferences",
      tags: ["users"],
    },
    patch: {
      operationId: "updateMyPreferences",
      requestBody: rb(SCHEMAS.TravelPreferences, true),
      responses: { "200": ok("Updated travel preferences", SCHEMAS.TravelPreferences), ...STD_ERRORS },
      security: AUTH_SEC,
      summary: "Update the authenticated traveler's travel preferences",
      tags: ["users"],
    },
  },
};

// ── Full document ────────────────────────────────────────────────────────────

const DOC = {
  components: {
    responses: ERROR_RESPONSES,
    schemas: { ErrorEnvelope: ErrorEnvelopeSchema },
    securitySchemes: {
      bearerAccessToken: {
        bearerFormat: "JWT",
        description:
          "Short-lived RS256 JWT (15-minute TTL) issued by auth-service. Claims: sub (userId), sid (sessionId), roles, jti.",
        scheme: "bearer",
        type: "http",
      },
      sessionCookie: {
        description:
          "HttpOnly Secure SameSite=Strict cookie. Set by the gateway on login and rotated on every refresh.",
        in: "cookie",
        name: "session",
        type: "apiKey",
      },
    },
  },
  info: {
    description:
      "v1 REST API for the AI-powered multi-supplier travel booking platform. " +
      "All error responses carry a `reference` field equal to the active X-Ray trace identifier, " +
      "allowing support to pivot from a traveler screenshot to a trace. " +
      "The `error.code` field is an ErrorCode enum value defined in @travel/contracts/errors.",
    title: "Travel Platform v1 API",
    version: "1.0.0",
  },
  openapi: "3.1.0",
  paths: PATHS,
  security: [{ bearerAccessToken: [] }, { sessionCookie: [] }],
  servers: [
    { description: "Production", url: "https://api.travel.example.com" },
    { description: "Local development (api-gateway)", url: "http://localhost:3000" },
  ],
  tags: [
    { description: "Authentication and session management", name: "auth" },
    { description: "Unified supplier search (guest-allowed)", name: "search" },
    { description: "Flight-specific search", name: "flights" },
    { description: "Hotel-specific search", name: "hotels" },
    { description: "Car rental search", name: "cars" },
    { description: "Traveler profile and preferences", name: "users" },
    { description: "Booking lifecycle (create, confirm, cancel)", name: "bookings" },
    { description: "Multi-leg itinerary management", name: "itineraries" },
    { description: "Stripe PaymentIntent and webhook handling", name: "payments" },
    { description: "AI conversational planning (guest-allowed)", name: "chat" },
  ],
};

// ── Stable serialisation ─────────────────────────────────────────────────────

function stableStringify(value) {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
      }
      return val;
    },
    2,
  );
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, stableStringify(DOC) + "\n", "utf8");
console.log("✓ OpenAPI spec written to", OUT);
