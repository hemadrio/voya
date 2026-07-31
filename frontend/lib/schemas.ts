/**
 * The Next.js web app no longer owns its own Zod schemas: every request,
 * response, event, and enum shape now lives in `@travel/contracts`, the
 * single source of truth shared with all nine services (WO-001).
 *
 * This file exists so existing imports of `frontend/lib/schemas.ts`
 * (`FlightSearchSchema` and its siblings) keep working while the rest of
 * the app migrates to importing `@travel/contracts` directly. It is a thin
 * re-export layer only — it must never redeclare a schema.
 */
export {
  FlightSearchRequestSchema as FlightSearchSchema,
  HotelSearchRequestSchema as HotelSearchSchema,
  CarRentalSearchRequestSchema as CarRentalSearchSchema,
  OfferSchema,
} from "@travel/contracts/search";
export type {
  FlightSearchRequest as FlightSearch,
  HotelSearchRequest as HotelSearch,
  CarRentalSearchRequest as CarRentalSearch,
  Offer,
} from "@travel/contracts/search";

export {
  CreateBookingRequestSchema,
  BookingResponseSchema,
  ItinerarySchema,
} from "@travel/contracts/booking";
export type {
  CreateBookingRequest,
  BookingResponse,
  Itinerary,
} from "@travel/contracts/booking";

export {
  RegisterRequestSchema,
  LoginRequestSchema,
} from "@travel/contracts/auth";
export type { RegisterRequest, LoginRequest } from "@travel/contracts/auth";

// ---------------------------------------------------------------------------
// Error envelope — re-exported so form resolvers and error-boundary code
// can import from one place without knowing the contracts subpath.
// ---------------------------------------------------------------------------
export { ErrorEnvelopeSchema, ErrorDetailSchema, ErrorCode } from "@travel/contracts/errors";
export type { ErrorEnvelope, ErrorDetail } from "@travel/contracts/errors";

// ---------------------------------------------------------------------------
// User / profile
// ---------------------------------------------------------------------------
export { ProfileSchema, TravelPreferencesSchema } from "@travel/contracts/user";
export type { Profile, TravelPreferences } from "@travel/contracts/user";

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------
export { PaymentIntentRequestSchema, PaymentIntentResponseSchema } from "@travel/contracts/payment";
export type { PaymentIntentRequest, PaymentIntentResponse } from "@travel/contracts/payment";
