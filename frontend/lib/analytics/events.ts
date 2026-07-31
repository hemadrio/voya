/**
 * Typed analytics event schema.
 *
 * All events are plain objects — no class instances, no circular refs.
 * PII scrubbing is enforced by the analytics client before any event is sent.
 *
 * Constraints (AC11, security):
 * - Event payloads must never contain email addresses, tokens, or payment data.
 * - scrubEvent() is the single enforcement point and is unit-tested.
 */

// ---------------------------------------------------------------------------
// Common dimensions
// ---------------------------------------------------------------------------

export interface CommonDimensions {
  /** Route pathname when the event was fired (e.g. "/search") */
  readonly route: string;
  /** Tab identifier if on search page ("FLIGHT" | "HOTEL" | "CAR") */
  readonly searchTab?: string;
  /** Correlation ID from the session or request context */
  readonly correlationId?: string;
  /** ISO 8601 timestamp — injected by the client */
  readonly timestamp?: string;
}

// ---------------------------------------------------------------------------
// Event type union
// ---------------------------------------------------------------------------

export type AnalyticsEvent =
  | SearchPerformedEvent
  | ListingViewedEvent
  | ReserveClickedEvent
  | CheckoutStepEvent
  | PaymentAttemptedEvent
  | BookingConfirmedEvent
  | BookingFailedEvent;

export type AnalyticsEventName = AnalyticsEvent["name"];

// ---------------------------------------------------------------------------
// Search performed
// ---------------------------------------------------------------------------

export interface SearchPerformedEvent {
  readonly name: "search_performed";
  readonly properties: CommonDimensions & {
    readonly searchType: "FLIGHT" | "HOTEL" | "CAR";
    readonly resultCount: number;
    readonly hasFilters: boolean;
    readonly currency?: string;
  };
}

// ---------------------------------------------------------------------------
// Listing viewed
// ---------------------------------------------------------------------------

export interface ListingViewedEvent {
  readonly name: "listing_viewed";
  readonly properties: CommonDimensions & {
    readonly listingId: string;
    readonly listingType: "FLIGHT" | "HOTEL" | "CAR";
    readonly price?: number;
    readonly currency?: string;
    readonly supplier?: string;
    readonly positionInResults?: number;
  };
}

// ---------------------------------------------------------------------------
// Reserve / book-now clicked
// ---------------------------------------------------------------------------

export interface ReserveClickedEvent {
  readonly name: "reserve_clicked";
  readonly properties: CommonDimensions & {
    readonly offerId: string;
    readonly offerType: "FLIGHT" | "HOTEL" | "CAR";
    readonly price?: number;
    readonly currency?: string;
  };
}

// ---------------------------------------------------------------------------
// Checkout step progression
// ---------------------------------------------------------------------------

export type CheckoutStep =
  | "passenger_details"
  | "review_price"
  | "payment"
  | "confirmation";

export interface CheckoutStepEvent {
  readonly name: "checkout_step";
  readonly properties: CommonDimensions & {
    readonly step: CheckoutStep;
    readonly stepIndex: number;
    readonly bookingType?: "FLIGHT" | "HOTEL" | "CAR";
  };
}

// ---------------------------------------------------------------------------
// Payment attempted
// ---------------------------------------------------------------------------

export interface PaymentAttemptedEvent {
  readonly name: "payment_attempted";
  readonly properties: CommonDimensions & {
    readonly bookingType?: "FLIGHT" | "HOTEL" | "CAR";
    readonly currency?: string;
    // Note: amount deliberately omitted — reconstructable from booking, not PII-safe to log
  };
}

// ---------------------------------------------------------------------------
// Booking confirmed
// ---------------------------------------------------------------------------

export interface BookingConfirmedEvent {
  readonly name: "booking_confirmed";
  readonly properties: CommonDimensions & {
    readonly bookingId: string;
    readonly bookingType?: "FLIGHT" | "HOTEL" | "CAR";
    readonly currency?: string;
  };
}

// ---------------------------------------------------------------------------
// Booking failed
// ---------------------------------------------------------------------------

export interface BookingFailedEvent {
  readonly name: "booking_failed";
  readonly properties: CommonDimensions & {
    readonly reason?: string;
    readonly bookingType?: "FLIGHT" | "HOTEL" | "CAR";
  };
}

// ---------------------------------------------------------------------------
// Event builder — attaches timestamp and route
// ---------------------------------------------------------------------------

export function buildEvent<T extends AnalyticsEvent>(
  event: Omit<T, "properties"> & {
    properties: Omit<T["properties"], "timestamp" | "route">;
  },
  route: string,
): T {
  return {
    ...event,
    properties: {
      ...event.properties,
      route,
      timestamp: new Date().toISOString(),
    },
  } as unknown as T;
}

// ---------------------------------------------------------------------------
// PII scrubbing — enforced before any event reaches the transport
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const TOKEN_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "apikey",
  "api_key",
  "sessionid",
  "session_id",
]);
const PAYMENT_KEYS = new Set([
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "pan",
  "expiry",
  "expirydate",
  "expiry_date",
  "cardholdername",
  "cardholder_name",
  "iban",
  "bic",
]);

/**
 * Deep-scrub a properties object, removing token/payment keys and
 * redacting email addresses from string values.
 *
 * Returns a new object — never mutates the input.
 */
export function scrubEvent<T extends Record<string, unknown>>(properties: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    const lowerKey = key.toLowerCase();

    // Drop token and payment keys entirely
    if (TOKEN_KEYS.has(lowerKey) || PAYMENT_KEYS.has(lowerKey)) {
      continue;
    }

    if (typeof value === "string") {
      // Redact embedded emails
      result[key] = value.replace(EMAIL_PATTERN, "[email]");
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = scrubEvent(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
