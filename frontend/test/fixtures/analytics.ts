/**
 * Analytics test fixtures — event payloads and expected shapes.
 */

import type {
  SearchPerformedEvent,
  ListingViewedEvent,
  ReserveClickedEvent,
  CheckoutStepEvent,
  PaymentAttemptedEvent,
  BookingConfirmedEvent,
} from "@/lib/analytics/events";

export const FIXTURE_SEARCH_EVENT: SearchPerformedEvent = {
  name: "search_performed",
  properties: {
    route: "/search",
    searchType: "FLIGHT",
    resultCount: 42,
    hasFilters: false,
    currency: "USD",
    timestamp: "2026-08-01T10:00:00.000Z",
  },
};

export const FIXTURE_LISTING_VIEW_EVENT: ListingViewedEvent = {
  name: "listing_viewed",
  properties: {
    route: "/hotels/marriott-paris",
    listingId: "hotel-marriott-paris-001",
    listingType: "HOTEL",
    price: 420,
    currency: "EUR",
    supplier: "RAPIDAPI",
    positionInResults: 1,
    timestamp: "2026-08-01T10:01:00.000Z",
  },
};

export const FIXTURE_RESERVE_CLICK_EVENT: ReserveClickedEvent = {
  name: "reserve_clicked",
  properties: {
    route: "/hotels/marriott-paris",
    offerId: "offer-abc-123",
    offerType: "HOTEL",
    price: 420,
    currency: "EUR",
    timestamp: "2026-08-01T10:02:00.000Z",
  },
};

export const FIXTURE_CHECKOUT_STEP_EVENT: CheckoutStepEvent = {
  name: "checkout_step",
  properties: {
    route: "/checkout",
    step: "payment",
    stepIndex: 3,
    bookingType: "HOTEL",
    timestamp: "2026-08-01T10:03:00.000Z",
  },
};

export const FIXTURE_PAYMENT_ATTEMPT_EVENT: PaymentAttemptedEvent = {
  name: "payment_attempted",
  properties: {
    route: "/checkout",
    bookingType: "HOTEL",
    currency: "EUR",
    timestamp: "2026-08-01T10:04:00.000Z",
  },
};

export const FIXTURE_BOOKING_CONFIRMED_EVENT: BookingConfirmedEvent = {
  name: "booking_confirmed",
  properties: {
    route: "/checkout",
    bookingId: "bk_001234",
    bookingType: "HOTEL",
    currency: "EUR",
    timestamp: "2026-08-01T10:05:00.000Z",
  },
};

// PII-contaminated events for scrubbing tests
export const FIXTURE_PII_EVENT = {
  name: "search_performed" as const,
  properties: {
    route: "/search",
    searchType: "FLIGHT" as const,
    resultCount: 10,
    hasFilters: false,
    // PII fields that must be scrubbed:
    email: "user@example.com",
    token: "Bearer eyJhbGciOiJSUzI1NiJ9.abc",
    password: "hunter2",
    cardNumber: "4111 1111 1111 1111",
    timestamp: "2026-08-01T10:00:00.000Z",
  },
};

export const FIXTURE_EMAIL_IN_STRING = {
  name: "search_performed" as const,
  properties: {
    route: "/search",
    searchType: "FLIGHT" as const,
    resultCount: 5,
    hasFilters: false,
    // Email embedded in a string value — must be replaced with [email]
    correlationId: "req_user@example.com_123",
    timestamp: "2026-08-01T10:00:00.000Z",
  },
};
