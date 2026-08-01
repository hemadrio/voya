/**
 * Account test fixtures (WO-069).
 *
 * Provides typed constants and MSW handlers for:
 *  - bookings list (upcoming, in-progress, past, cancelled)
 *  - booking detail
 *  - cancellation preview + confirm
 *  - modification preview + confirm
 *  - wishlist list + removal
 *  - profile get + update
 *  - password change
 *  - account deletion
 *
 * Usage in tests:
 *   server.use(...accountHandlers)            // happy path
 *   server.use(HANDLER_CANCEL_CONFLICT)       // override one endpoint
 */

import { http, HttpResponse } from "msw";
import type {
  BookingListItem,
  BookingDetail,
  CancellationPreview,
  CancellationResult,
  ModificationPreview,
  ModificationResult,
  WishlistItem,
  Profile,
  DeletionResult,
} from "@/lib/api/account.js";

const BASE_URL = "http://localhost:4000/api/v1";

// ---------------------------------------------------------------------------
// Booking list fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_BOOKING_UPCOMING: BookingListItem = {
  bookingId: "booking-001",
  reference: "VYA-2026-001",
  status: "confirmed",
  listing: {
    id: "listing-001",
    slug: "grand-villa-paris",
    title: "Grand Villa Paris",
    heroImage: "https://cdn.example.com/villa-paris.jpg",
    location: "Paris, France",
  },
  checkIn: "2026-09-15",
  checkOut: "2026-09-20",
  timezone: "Europe/Paris",
  guests: { adults: 2, children: 0, infants: 0 },
  total: { currency: "GBP", amount: 150000 },
  cancellationDeadline: "2026-09-12T00:00:00.000Z",
  canCancel: true,
  canModify: true,
};

export const FIXTURE_BOOKING_IN_PROGRESS: BookingListItem = {
  bookingId: "booking-002",
  reference: "VYA-2026-002",
  status: "confirmed",
  listing: {
    id: "listing-002",
    slug: "beach-house-bali",
    title: "Beach House Bali",
    heroImage: "https://cdn.example.com/bali.jpg",
    location: "Bali, Indonesia",
  },
  checkIn: "2026-07-28",
  checkOut: "2026-08-05",
  timezone: "Asia/Makassar",
  guests: { adults: 2, children: 1, infants: 0 },
  total: { currency: "GBP", amount: 95000 },
  cancellationDeadline: "2026-07-26T00:00:00.000Z",
  canCancel: false,
  canModify: false,
};

export const FIXTURE_BOOKING_PAST: BookingListItem = {
  bookingId: "booking-003",
  reference: "VYA-2026-003",
  status: "confirmed",
  listing: {
    id: "listing-003",
    slug: "alpine-chalet-zermatt",
    title: "Alpine Chalet Zermatt",
    heroImage: "https://cdn.example.com/zermatt.jpg",
    location: "Zermatt, Switzerland",
  },
  checkIn: "2026-02-01",
  checkOut: "2026-02-07",
  timezone: "Europe/Zurich",
  guests: { adults: 4, children: 0, infants: 0 },
  total: { currency: "GBP", amount: 200000 },
  cancellationDeadline: "2026-01-29T00:00:00.000Z",
  canCancel: false,
  canModify: false,
};

export const FIXTURE_BOOKING_CANCELLED: BookingListItem = {
  bookingId: "booking-004",
  reference: "VYA-2026-004",
  status: "cancelled",
  listing: {
    id: "listing-004",
    slug: "tokyo-apartment",
    title: "Tokyo Apartment",
    heroImage: "https://cdn.example.com/tokyo.jpg",
    location: "Tokyo, Japan",
  },
  checkIn: "2026-05-01",
  checkOut: "2026-05-07",
  timezone: "Asia/Tokyo",
  guests: { adults: 2, children: 0, infants: 0 },
  total: { currency: "GBP", amount: 80000 },
  cancellationDeadline: "2026-04-28T00:00:00.000Z",
  canCancel: false,
  canModify: false,
};

export const FIXTURE_BOOKING_LIST = {
  items: [
    FIXTURE_BOOKING_UPCOMING,
    FIXTURE_BOOKING_IN_PROGRESS,
    FIXTURE_BOOKING_PAST,
    FIXTURE_BOOKING_CANCELLED,
  ],
  page: 1,
  totalPages: 1,
};

// Empty list — brand-new account
export const FIXTURE_BOOKING_LIST_EMPTY = { items: [], page: 1, totalPages: 0 };

// ---------------------------------------------------------------------------
// Booking detail fixture
// ---------------------------------------------------------------------------

export const FIXTURE_BOOKING_DETAIL: BookingDetail = {
  ...FIXTURE_BOOKING_UPCOMING,
  lineItems: [
    { code: "base_rate", label: "5 nights × £240", amount: 120000, currency: "GBP" },
    { code: "cleaning_fee", label: "Cleaning fee", amount: 15000, currency: "GBP" },
    { code: "service_fee", label: "Service fee", amount: 15000, currency: "GBP" },
  ],
  payments: [
    {
      id: "pay-001",
      method: "card",
      last4: "4242",
      amount: 150000,
      capturedAt: "2026-07-01T10:00:00.000Z",
      receiptUrl: "/account/bookings/booking-001/receipt",
    },
  ],
  policies: [
    {
      type: "cancellation",
      label: "Flexible",
      description:
        "Free cancellation until 72 hours before check-in. Non-refundable after that.",
    },
  ],
  host: {
    name: "Marie Dupont",
    contactAvailableFrom: "2026-09-10T08:00:00.000Z",
  },
  voucherUrl: "/account/bookings/booking-001/voucher",
};

// Non-refundable booking (past cancellation deadline)
export const FIXTURE_BOOKING_NON_REFUNDABLE: BookingDetail = {
  ...FIXTURE_BOOKING_DETAIL,
  bookingId: "booking-005",
  reference: "VYA-2026-005",
  cancellationDeadline: "2026-07-01T00:00:00.000Z",
  canCancel: false,
};

// ---------------------------------------------------------------------------
// Cancellation fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_CANCELLATION_PREVIEW: CancellationPreview = {
  refundableAmount: 135000,
  penalties: [{ label: "Service fee (non-refundable)", amount: 15000 }],
  nonRefundableAmount: 15000,
  currency: "GBP",
  settlementEtaDays: 5,
};

export const FIXTURE_CANCELLATION_PREVIEW_NONE_REFUNDABLE: CancellationPreview = {
  refundableAmount: 0,
  penalties: [{ label: "Full booking (past deadline)", amount: 150000 }],
  nonRefundableAmount: 150000,
  currency: "GBP",
  settlementEtaDays: 0,
};

export const FIXTURE_CANCELLATION_RESULT: CancellationResult = {
  status: "cancelled",
  refund: { amount: 135000, currency: "GBP", settlementEtaDays: 5 },
};

// ---------------------------------------------------------------------------
// Modification fixtures
// ---------------------------------------------------------------------------

// Modification with an additional charge
export const FIXTURE_MODIFICATION_PREVIEW: ModificationPreview = {
  available: true,
  priceDifference: { amount: 10000, currency: "GBP" },
  newTotal: 160000,
};

// Modification that results in a refund (shorter stay)
export const FIXTURE_MODIFICATION_PREVIEW_REFUND: ModificationPreview = {
  available: true,
  priceDifference: { amount: -20000, currency: "GBP" },
  newTotal: 130000,
};

export const FIXTURE_MODIFICATION_RESULT: ModificationResult = {
  status: "pending_modification",
};

// ---------------------------------------------------------------------------
// Wishlist fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_WISHLIST_ITEMS: WishlistItem[] = [
  {
    listingId: "listing-010",
    listingSlug: "villa-santorini",
    title: "Villa Santorini",
    heroImage: "https://cdn.example.com/santorini.jpg",
    location: "Santorini, Greece",
    priceFrom: 45000,
    currency: "GBP",
    available: true,
    savedAt: "2026-06-01T10:00:00.000Z",
  },
  {
    listingId: "listing-011",
    listingSlug: "mountain-retreat-peru",
    title: "Mountain Retreat Peru",
    heroImage: "https://cdn.example.com/peru.jpg",
    location: "Cusco, Peru",
    priceFrom: 28000,
    currency: "GBP",
    available: true,
    savedAt: "2026-06-10T10:00:00.000Z",
  },
];

// Wishlist with a delisted / unavailable listing
export const FIXTURE_WISHLIST_WITH_UNAVAILABLE: WishlistItem[] = [
  ...FIXTURE_WISHLIST_ITEMS,
  {
    listingId: "listing-012",
    listingSlug: "delisted-beach-cabin",
    title: "Beach Cabin (unavailable)",
    heroImage: "",
    location: "Maldives",
    available: false,
    savedAt: "2026-05-01T10:00:00.000Z",
  },
];

// ---------------------------------------------------------------------------
// Profile fixture
// ---------------------------------------------------------------------------

export const FIXTURE_PROFILE: Profile = {
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  phone: "+44 7700 123456",
  avatarUrl: "https://cdn.example.com/avatars/alice.jpg",
  locale: "en-GB",
  currency: "GBP",
  marketingOptIn: false,
};

// ---------------------------------------------------------------------------
// Deletion fixture
// ---------------------------------------------------------------------------

export const FIXTURE_DELETION_RESULT: DeletionResult = {
  status: "pending_deletion",
  effectiveAt: "2026-09-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// MSW handlers — happy path
// ---------------------------------------------------------------------------

export const accountHandlers = [
  // Bookings list
  http.get(`${BASE_URL}/account/bookings`, () =>
    HttpResponse.json(FIXTURE_BOOKING_LIST),
  ),

  // Booking detail — 404 for unknown bookingId
  http.get(`${BASE_URL}/account/bookings/:bookingId`, ({ params }) => {
    if (params.bookingId === "booking-001") {
      return HttpResponse.json(FIXTURE_BOOKING_DETAIL);
    }
    return HttpResponse.json(
      { code: "NOT_FOUND", message: "Booking not found." },
      { status: 404 },
    );
  }),

  // Cancellation preview
  http.post(`${BASE_URL}/account/bookings/:bookingId/cancellation/preview`, () =>
    HttpResponse.json(FIXTURE_CANCELLATION_PREVIEW),
  ),

  // Cancel booking
  http.post(`${BASE_URL}/account/bookings/:bookingId/cancel`, () =>
    HttpResponse.json(FIXTURE_CANCELLATION_RESULT),
  ),

  // Modification preview
  http.post(`${BASE_URL}/account/bookings/:bookingId/modification/preview`, () =>
    HttpResponse.json(FIXTURE_MODIFICATION_PREVIEW),
  ),

  // Request modification
  http.post(`${BASE_URL}/account/bookings/:bookingId/modification`, () =>
    HttpResponse.json(FIXTURE_MODIFICATION_RESULT),
  ),

  // Wishlist list
  http.get(`${BASE_URL}/account/wishlist`, () =>
    HttpResponse.json({ items: FIXTURE_WISHLIST_ITEMS }),
  ),

  // Remove wishlist item
  http.delete(`${BASE_URL}/account/wishlist/:listingId`, () =>
    new HttpResponse(null, { status: 204 }),
  ),

  // Profile get
  http.get(`${BASE_URL}/account/profile`, () =>
    HttpResponse.json(FIXTURE_PROFILE),
  ),

  // Profile update
  http.patch(`${BASE_URL}/account/profile`, () =>
    HttpResponse.json(FIXTURE_PROFILE),
  ),

  // Password change
  http.post(`${BASE_URL}/account/password`, () =>
    new HttpResponse(null, { status: 204 }),
  ),

  // Account deletion
  http.post(`${BASE_URL}/account/deletion`, () =>
    HttpResponse.json(FIXTURE_DELETION_RESULT),
  ),
];

// ---------------------------------------------------------------------------
// Individual override handlers — use with server.use() in specific tests
// ---------------------------------------------------------------------------

/** ALREADY_CANCELLED conflict on cancellation preview */
export const HANDLER_CANCEL_ALREADY_CANCELLED = http.post(
  `${BASE_URL}/account/bookings/:bookingId/cancellation/preview`,
  () =>
    HttpResponse.json(
      { code: "ALREADY_CANCELLED", message: "This booking has already been cancelled." },
      { status: 409 },
    ),
);

/** DEADLINE_PASSED returns non-refundable preview */
export const HANDLER_CANCEL_DEADLINE_PASSED = http.post(
  `${BASE_URL}/account/bookings/:bookingId/cancellation/preview`,
  () => HttpResponse.json(FIXTURE_CANCELLATION_PREVIEW_NONE_REFUNDABLE),
);

/** Wishlist removal server error — triggers rollback */
export const HANDLER_WISHLIST_REMOVE_FAIL = http.delete(
  `${BASE_URL}/account/wishlist/:listingId`,
  () =>
    HttpResponse.json(
      { code: "INTERNAL_ERROR", message: "Failed to remove item." },
      { status: 500 },
    ),
);

/** Incorrect current password */
export const HANDLER_PASSWORD_WRONG = http.post(
  `${BASE_URL}/account/password`,
  () =>
    HttpResponse.json(
      {
        code: "INVALID_CURRENT_PASSWORD",
        message: "The current password is incorrect.",
        fieldErrors: { currentPassword: ["Incorrect password."] },
      },
      { status: 400 },
    ),
);

/** Profile field-level validation error */
export const HANDLER_PROFILE_FIELD_ERROR = http.patch(
  `${BASE_URL}/account/profile`,
  () =>
    HttpResponse.json(
      {
        code: "VALIDATION_ERROR",
        message: "Validation failed.",
        fieldErrors: { phone: ["Invalid phone number format."] },
      },
      { status: 422 },
    ),
);

/** Modification dates unavailable */
export const HANDLER_MODIFICATION_UNAVAILABLE = http.post(
  `${BASE_URL}/account/bookings/:bookingId/modification/preview`,
  () =>
    HttpResponse.json(
      { code: "DATES_UNAVAILABLE", message: "The selected dates are not available." },
      { status: 409 },
    ),
);

/** Empty bookings list — brand-new account */
export const HANDLER_BOOKINGS_EMPTY = http.get(
  `${BASE_URL}/account/bookings`,
  () => HttpResponse.json(FIXTURE_BOOKING_LIST_EMPTY),
);
