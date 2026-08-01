/**
 * Checkout test fixtures (WO-068).
 *
 * Provides typed constants and MSW handlers for:
 *  - valid / expired draft
 *  - revalidation (unchanged, price-changed)
 *  - promo code (valid, invalid, expired, not-applicable)
 *  - payment intent (standard, requires-3DS)
 *  - booking creation (pending, confirmed)
 *  - booking status polling (confirmed, failed)
 */

import { http, HttpResponse } from "msw";
import type { BookingDraft } from "@/lib/booking/draft.js";
import type { RevalidatedQuote } from "@/lib/api/bookings.js";
import type { PromoValidationResult } from "@/lib/api/bookings.js";
import type { BookingCreatedResponse, BookingStatusResponse } from "@/lib/api/bookings.js";
import type { PaymentIntentResponse } from "@/lib/api/payments.js";

const BASE_URL = "http://localhost:4000/api/v1";

// ---------------------------------------------------------------------------
// Draft fixtures
// ---------------------------------------------------------------------------

const FUTURE_DATE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST_DATE = new Date(Date.now() - 60 * 1000).toISOString();

export const FIXTURE_VALID_DRAFT: BookingDraft = {
  listingId: "listing-001",
  listingSlug: "grand-villa-paris",
  checkIn: "2026-09-01",
  checkOut: "2026-09-07",
  adults: 2,
  children: 0,
  infants: 0,
  quoteId: "quote-abc123",
  quoteExpiresAt: FUTURE_DATE,
  currency: "GBP",
  total: 150000, // £1,500.00 in pence / centimes
  draftId: "draft-uuid-001",
  completedSteps: [],
  stepData: {},
};

export const FIXTURE_EXPIRED_DRAFT: BookingDraft = {
  ...FIXTURE_VALID_DRAFT,
  quoteExpiresAt: PAST_DATE,
};

export const FIXTURE_DRAFT_WITH_TRAVELER: BookingDraft = {
  ...FIXTURE_VALID_DRAFT,
  completedSteps: ["traveler"],
  stepData: {
    traveler: {
      primary: {
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        phone: "+44 7700 123456",
      },
      guests: [],
      specialRequests: undefined,
      consents: { terms: true, cancellationPolicy: true, marketing: false },
    },
  },
};

export const FIXTURE_DRAFT_THROUGH_REVIEW: BookingDraft = {
  ...FIXTURE_DRAFT_WITH_TRAVELER,
  completedSteps: ["traveler", "extras", "review"],
  revalidatedTotal: 150000,
  stepData: {
    ...FIXTURE_DRAFT_WITH_TRAVELER.stepData,
    extras: { extras: [], promoCode: "" },
    priceChangeAcknowledged: false,
  },
};

// ---------------------------------------------------------------------------
// Quote revalidation fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_REVALIDATED_QUOTE_UNCHANGED: RevalidatedQuote = {
  quoteId: "quote-abc123",
  expiresAt: FUTURE_DATE,
  total: 150000,
  lineItems: [
    { code: "base_rate", label: "6 nights × £200", amount: 120000 },
    { code: "cleaning_fee", label: "Cleaning fee", amount: 15000 },
    { code: "service_fee", label: "Service fee", amount: 15000 },
  ],
  changed: false,
};

export const FIXTURE_REVALIDATED_QUOTE_PRICE_INCREASED: RevalidatedQuote = {
  ...FIXTURE_REVALIDATED_QUOTE_UNCHANGED,
  total: 165000,
  previousTotal: 150000,
  changed: true,
};

export const FIXTURE_REVALIDATED_QUOTE_PRICE_DECREASED: RevalidatedQuote = {
  ...FIXTURE_REVALIDATED_QUOTE_UNCHANGED,
  total: 140000,
  previousTotal: 150000,
  changed: true,
};

// ---------------------------------------------------------------------------
// Promo code fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_PROMO_RESULT_VALID: PromoValidationResult = {
  code: "SUMMER10",
  label: "Summer 10% off",
  discountAmount: 15000,
  newTotal: 135000,
};

export const FIXTURE_PROMO_ERROR_INVALID = {
  status: 422,
  body: { code: "PROMO_INVALID", message: "This promo code is not valid." },
};

export const FIXTURE_PROMO_ERROR_EXPIRED = {
  status: 422,
  body: { code: "PROMO_EXPIRED", message: "This promo code has expired." },
};

export const FIXTURE_PROMO_ERROR_NOT_APPLICABLE = {
  status: 422,
  body: {
    code: "PROMO_NOT_APPLICABLE",
    message: "This promo code cannot be applied to your booking.",
  },
};

// ---------------------------------------------------------------------------
// Payment intent fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_PAYMENT_INTENT: PaymentIntentResponse = {
  paymentIntentId: "pi_test_001",
  clientSecret: "pi_test_001_secret_abc",
  requiresAction: false,
  supportedMethods: ["card"],
};

export const FIXTURE_PAYMENT_INTENT_3DS: PaymentIntentResponse = {
  ...FIXTURE_PAYMENT_INTENT,
  requiresAction: true,
};

// ---------------------------------------------------------------------------
// Booking fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_BOOKING_PENDING: BookingCreatedResponse = {
  bookingId: "booking-xyz789",
  reference: "VYA-2026-001",
  status: "pending",
  total: 150000,
  cancellationDeadline: "2026-08-28T00:00:00.000Z",
};

export const FIXTURE_BOOKING_CONFIRMED: BookingCreatedResponse = {
  ...FIXTURE_BOOKING_PENDING,
  status: "confirmed",
};

export const FIXTURE_BOOKING_STATUS_CONFIRMED: BookingStatusResponse = {
  status: "confirmed",
  reference: "VYA-2026-001",
};

export const FIXTURE_BOOKING_STATUS_FAILED: BookingStatusResponse = {
  status: "failed",
  failureReason: "Payment was declined by the card issuer.",
};

// ---------------------------------------------------------------------------
// MSW handlers
// ---------------------------------------------------------------------------

export const checkoutHandlers = [
  // Quote revalidation
  http.post(`${BASE_URL}/quotes/:quoteId/revalidate`, () =>
    HttpResponse.json(FIXTURE_REVALIDATED_QUOTE_UNCHANGED),
  ),

  // Promo validation
  http.post(`${BASE_URL}/promotions/validate`, () =>
    HttpResponse.json(FIXTURE_PROMO_RESULT_VALID),
  ),

  // Payment intent
  http.post(`${BASE_URL}/payments/intents`, () =>
    HttpResponse.json(FIXTURE_PAYMENT_INTENT),
  ),

  // Create booking
  http.post(`${BASE_URL}/bookings`, () =>
    HttpResponse.json(FIXTURE_BOOKING_CONFIRMED),
  ),

  // Booking status
  http.get(`${BASE_URL}/bookings/:bookingId/status`, () =>
    HttpResponse.json(FIXTURE_BOOKING_STATUS_CONFIRMED),
  ),
];

export const checkoutHandlersPriceChanged = [
  http.post(`${BASE_URL}/quotes/:quoteId/revalidate`, () =>
    HttpResponse.json(FIXTURE_REVALIDATED_QUOTE_PRICE_INCREASED),
  ),
  ...checkoutHandlers.slice(1),
];

export const checkoutHandlersDeclinedPayment = [
  http.post(`${BASE_URL}/quotes/:quoteId/revalidate`, () =>
    HttpResponse.json(FIXTURE_REVALIDATED_QUOTE_UNCHANGED),
  ),
  http.post(`${BASE_URL}/promotions/validate`, () =>
    HttpResponse.json(FIXTURE_PROMO_RESULT_VALID),
  ),
  http.post(`${BASE_URL}/payments/intents`, () =>
    HttpResponse.json(FIXTURE_PAYMENT_INTENT),
  ),
  http.post(`${BASE_URL}/bookings`, () =>
    HttpResponse.json(
      { code: "PAYMENT_DECLINED", message: "Payment was declined." },
      { status: 402 },
    ),
  ),
  http.get(`${BASE_URL}/bookings/:bookingId/status`, () =>
    HttpResponse.json(FIXTURE_BOOKING_STATUS_CONFIRMED),
  ),
];
