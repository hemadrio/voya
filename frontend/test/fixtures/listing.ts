import { http, HttpResponse } from "msw";
import type {
  ListingDetail,
  AvailabilityResponse,
  QuoteResponse,
  ReviewsResponse,
} from "@/lib/api/listings.js";

const BASE_URL = "http://localhost:4000/api/v1";

// ---------------------------------------------------------------------------
// Full listing fixture
// ---------------------------------------------------------------------------

export const FIXTURE_LISTING_FULL: ListingDetail = {
  id: "listing-001",
  slug: "grand-villa-paris",
  title: "Grand Villa Paris",
  type: "villa",
  status: "active",
  description: "A beautiful villa in the heart of Paris with stunning views of the Eiffel Tower.",
  highlights: [
    "Panoramic Eiffel Tower views",
    "Private heated pool",
    "Chef's kitchen",
    "5-minute walk to Champs-Élysées",
  ],
  amenities: [
    { code: "wifi", label: "WiFi", group: "connectivity" },
    { code: "pool", label: "Private pool", group: "outdoor" },
    { code: "kitchen", label: "Full kitchen", group: "kitchen" },
    { code: "parking", label: "Free parking", group: "transport" },
    { code: "gym", label: "Gym", group: "health" },
    { code: "washer", label: "Washer", group: "laundry" },
    { code: "dryer", label: "Dryer", group: "laundry" },
    { code: "air_conditioning", label: "Air conditioning", group: "comfort" },
    { code: "heating", label: "Heating", group: "comfort" },
    { code: "tv", label: "Smart TV", group: "entertainment" },
    { code: "workspace", label: "Workspace", group: "work" },
    { code: "ev_charger", label: "EV charger", group: "transport" },
  ],
  images: [
    {
      url: "https://example.com/images/villa-paris-1.jpg",
      blurHash: "L6Pj0^jE.AyE_3t7t7R*0Koe",
      width: 1920,
      height: 1080,
      alt: "Living room with Eiffel Tower view",
    },
    {
      url: "https://example.com/images/villa-paris-2.jpg",
      blurHash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
      width: 1920,
      height: 1080,
      alt: "Private pool and terrace",
    },
    {
      url: "https://example.com/images/villa-paris-3.jpg",
      blurHash: "LES6:{03~URj}H=dODw]Wnt5ofNG",
      width: 1920,
      height: 1080,
      alt: "Master bedroom",
    },
    {
      url: "https://example.com/images/villa-paris-4.jpg",
      blurHash: "L5H2EC=PM+yV0g-mq.wG9c010J}I",
      width: 1920,
      height: 1080,
      alt: "Chef's kitchen",
    },
    {
      url: "https://example.com/images/villa-paris-5.jpg",
      blurHash: "LGF5]+Yk^6#M@-5c,1J5@[or[Q6.",
      width: 1920,
      height: 1080,
      alt: "Dining room",
    },
  ],
  approximateLocation: {
    lat: 48.8566,
    lng: 2.3522,
    radiusMeters: 500,
    city: "Paris",
    country: "France",
  },
  host: {
    id: "host-001",
    name: "Marie Dubois",
    avatarUrl: "https://example.com/avatars/marie.jpg",
    joinedAt: "2019-03-15T00:00:00Z",
    responseRate: 0.98,
    verified: true,
  },
  policies: {
    cancellation: {
      type: "moderate",
      description: "Full refund if cancelled at least 5 days before check-in.",
      deadlineHours: 120,
    },
    checkInFrom: "15:00",
    checkOutBy: "11:00",
    houseRules: [
      "No smoking indoors",
      "No parties or events",
      "Pets allowed with prior approval",
      "Quiet hours after 22:00",
    ],
  },
  rating: {
    average: 4.87,
    count: 214,
    categories: [
      { code: "cleanliness", average: 4.9 },
      { code: "accuracy", average: 4.8 },
      { code: "communication", average: 5.0 },
      { code: "location", average: 4.9 },
      { code: "check_in", average: 4.8 },
      { code: "value", average: 4.7 },
    ],
  },
  minimumStay: 2,
  maximumStay: 30,
  maxGuests: 8,
  currency: "EUR",
};

// ---------------------------------------------------------------------------
// Listing with no reviews
// ---------------------------------------------------------------------------

export const FIXTURE_LISTING_NO_REVIEWS: ListingDetail = {
  ...FIXTURE_LISTING_FULL,
  id: "listing-002",
  slug: "new-studio-montmartre",
  title: "New Studio Montmartre",
  rating: { average: 0, count: 0, categories: [] },
};

// ---------------------------------------------------------------------------
// Blocked availability fixture
// ---------------------------------------------------------------------------

export const FIXTURE_AVAILABILITY_BLOCKED: AvailabilityResponse = {
  blockedRanges: [
    { start: "2026-08-10", end: "2026-08-20", reason: "booked" },
    { start: "2026-08-25", end: "2026-08-28", reason: "blocked" },
  ],
  minimumStayByDate: {
    "2026-08-01": 3,
    "2026-08-21": 2,
  },
  checkInAllowedDays: [1, 2, 3, 4, 5, 6, 0], // all days
};

export const FIXTURE_AVAILABILITY_OPEN: AvailabilityResponse = {
  blockedRanges: [],
  minimumStayByDate: {},
  checkInAllowedDays: [1, 2, 3, 4, 5, 6, 0],
};

// ---------------------------------------------------------------------------
// Quote fixture
// ---------------------------------------------------------------------------

export const FIXTURE_QUOTE: QuoteResponse = {
  quoteId: "quote-abc123",
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  currency: "EUR",
  nights: 5,
  nightlyRate: 350,
  lineItems: [
    { code: "nightly_rate", label: "€350 × 5 nights", amount: 1750 },
    { code: "cleaning_fee", label: "Cleaning fee", amount: 75 },
  ],
  discounts: [
    { code: "weekly_discount", label: "Weekly discount (5%)", amount: 87.5 },
  ],
  taxes: [
    { label: "City tax", amount: 25 },
    { label: "Service fee", amount: 87.5 },
  ],
  total: 1850,
};

// ---------------------------------------------------------------------------
// MSW handlers
// ---------------------------------------------------------------------------

export const listingHandlers = [
  http.get(`${BASE_URL}/listings/:slug`, ({ params }) => {
    if (params.slug === "grand-villa-paris") {
      return HttpResponse.json(FIXTURE_LISTING_FULL);
    }
    if (params.slug === "new-studio-montmartre") {
      return HttpResponse.json(FIXTURE_LISTING_NO_REVIEWS);
    }
    return HttpResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }),

  http.get(`${BASE_URL}/listings/:id/availability`, ({ params }) => {
    if (params.id === "listing-001") {
      return HttpResponse.json(FIXTURE_AVAILABILITY_BLOCKED);
    }
    return HttpResponse.json(FIXTURE_AVAILABILITY_OPEN);
  }),

  http.post(`${BASE_URL}/listings/:id/quote`, () => {
    return HttpResponse.json(FIXTURE_QUOTE);
  }),

  http.get(`${BASE_URL}/listings/:id/reviews`, (): Response => {
    const reviewsResponse: ReviewsResponse = {
      items: [
        {
          id: "review-001",
          author: { name: "Alice Smith", avatarUrl: "https://example.com/avatars/alice.jpg" },
          rating: 5,
          categories: [
            { code: "cleanliness", average: 5 },
            { code: "value", average: 4 },
          ],
          createdAt: "2026-06-15T10:00:00Z",
          body: "Absolutely stunning villa. The views were breathtaking and the host was incredibly attentive.",
          hostReply: "Thank you so much, Alice! It was a pleasure having you.",
        },
        {
          id: "review-002",
          author: { name: "Bob Chen", avatarUrl: "https://example.com/avatars/bob.jpg" },
          rating: 4,
          categories: [
            { code: "cleanliness", average: 5 },
            { code: "value", average: 3 },
          ],
          createdAt: "2026-05-20T08:30:00Z",
          body: "Great location and beautiful space. The pool was amazing.",
        },
      ],
      nextCursor: null,
    };
    return HttpResponse.json(reviewsResponse) as Response;
  }),
];

export const listingNotFoundHandler = http.get(`${BASE_URL}/listings/:slug`, () => {
  return HttpResponse.json({ code: "NOT_FOUND" }, { status: 404 });
});
