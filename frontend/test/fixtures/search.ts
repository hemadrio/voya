import { http, HttpResponse } from "msw";
import type { SearchResponse, SearchResultItem } from "@/lib/api/search.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export const FIXTURE_ITEM_1: SearchResultItem = {
  id: "item-001",
  slug: "grand-palace-hotel",
  title: "Grand Palace Hotel",
  type: "hotel",
  location: { city: "Paris", country: "France", lat: 48.8566, lng: 2.3522 },
  heroImage: { url: "https://example.com/images/grand-palace.jpg", blurHash: "L6Pj0^jE.AyE_3t7t7R*0Koe" },
  rating: { average: 4.7, count: 1243 },
  amenities: ["WiFi", "Pool", "Spa", "Restaurant", "Gym"],
  price: { currency: "USD", nightly: 189, total: 945, nights: 5, taxesIncluded: true },
  freeCancellation: true,
  wishlisted: false,
};

export const FIXTURE_ITEM_2: SearchResultItem = {
  id: "item-002",
  slug: "cozy-apartment-montmartre",
  title: "Cozy Apartment Montmartre",
  type: "apartment",
  location: { city: "Paris", country: "France", lat: 48.8842, lng: 2.3384 },
  heroImage: { url: "https://example.com/images/montmartre.jpg", blurHash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" },
  rating: { average: 4.5, count: 387 },
  amenities: ["WiFi", "Kitchen", "Washer"],
  price: { currency: "USD", nightly: 95, total: 475, nights: 5, taxesIncluded: false },
  freeCancellation: false,
  wishlisted: true,
};

export const FIXTURE_ITEM_3: SearchResultItem = {
  id: "item-003",
  slug: "budget-inn-central",
  title: "Budget Inn Central",
  type: "hostel",
  location: { city: "Paris", country: "France", lat: 48.8698, lng: 2.3491 },
  heroImage: { url: "https://example.com/images/budget-inn.jpg", blurHash: "LES6:{03~URj}H=dODw]Wnt5ofNG" },
  rating: { average: 3.8, count: 512 },
  amenities: ["WiFi"],
  price: { currency: "USD", nightly: 35, total: 175, nights: 5, taxesIncluded: false },
  freeCancellation: true,
  wishlisted: false,
};

export const FIXTURE_FACETS = {
  priceHistogram: [
    { bucket: 0, count: 5 },
    { bucket: 50, count: 12 },
    { bucket: 100, count: 20 },
    { bucket: 150, count: 15 },
    { bucket: 200, count: 8 },
    { bucket: 300, count: 3 },
  ],
  amenities: [
    { value: "WiFi", label: "WiFi", count: 34 },
    { value: "Pool", label: "Swimming Pool", count: 18 },
    { value: "Gym", label: "Gym / Fitness", count: 12 },
    { value: "Spa", label: "Spa", count: 8 },
    { value: "Restaurant", label: "Restaurant", count: 22 },
    { value: "Kitchen", label: "Kitchen", count: 15 },
    { value: "Washer", label: "Washer/Dryer", count: 10 },
  ],
  ratings: [
    { min: 2, count: 48 },
    { min: 3, count: 40 },
    { min: 4, count: 28 },
    { min: 5, count: 6 },
  ],
  types: [
    { value: "hotel", count: 25 },
    { value: "apartment", count: 12 },
    { value: "hostel", count: 8 },
    { value: "villa", count: 5 },
  ],
};

// ---------------------------------------------------------------------------
// Full result page fixture (3 items, page 1 of 3)
// ---------------------------------------------------------------------------

export const FIXTURE_FULL_PAGE: SearchResponse = {
  items: [FIXTURE_ITEM_1, FIXTURE_ITEM_2, FIXTURE_ITEM_3],
  page: 1,
  pageSize: 20,
  totalItems: 50,
  totalPages: 3,
  facets: FIXTURE_FACETS,
};

// ---------------------------------------------------------------------------
// Single result fixture
// ---------------------------------------------------------------------------

export const FIXTURE_SINGLE_RESULT: SearchResponse = {
  items: [FIXTURE_ITEM_1],
  page: 1,
  pageSize: 20,
  totalItems: 1,
  totalPages: 1,
  facets: {
    ...FIXTURE_FACETS,
    amenities: FIXTURE_FACETS.amenities.map((a) => ({ ...a, count: a.value === "Pool" ? 1 : 0 })),
  },
};

// ---------------------------------------------------------------------------
// Zero results fixture
// ---------------------------------------------------------------------------

export const FIXTURE_ZERO_RESULTS: SearchResponse = {
  items: [],
  page: 1,
  pageSize: 20,
  totalItems: 0,
  totalPages: 0,
  facets: {
    priceHistogram: [],
    amenities: FIXTURE_FACETS.amenities.map((a) => ({ ...a, count: 0 })),
    ratings: FIXTURE_FACETS.ratings.map((r) => ({ ...r, count: 0 })),
    types: FIXTURE_FACETS.types.map((t) => ({ ...t, count: 0 })),
  },
};

// ---------------------------------------------------------------------------
// Facet-only payload (partial failure scenario)
// ---------------------------------------------------------------------------

export const FIXTURE_FACET_ONLY: SearchResponse = {
  items: [FIXTURE_ITEM_1],
  page: 1,
  pageSize: 20,
  totalItems: 1,
  totalPages: 1,
  facets: FIXTURE_FACETS,
};

// ---------------------------------------------------------------------------
// MSW handlers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:4000/api/v1";

export const searchHandlers = [
  http.get(`${BASE_URL}/search`, ({ request }) => {
    const url = new URL(request.url);
    const destination = url.searchParams.get("destination") ?? "";
    const minRating = url.searchParams.get("minRating");
    const freeCancellation = url.searchParams.get("freeCancellation");
    const amenities = url.searchParams.getAll("amenities");
    const type = url.searchParams.get("type");

    // Zero results when destination is "empty"
    if (destination.toLowerCase() === "empty") {
      return HttpResponse.json(FIXTURE_ZERO_RESULTS);
    }

    // Single result for highly filtered requests
    const isHeavilyFiltered =
      (minRating !== null && parseFloat(minRating) >= 4.5) ||
      freeCancellation === "true" ||
      amenities.length >= 3;

    if (isHeavilyFiltered) {
      return HttpResponse.json(FIXTURE_SINGLE_RESULT);
    }

    // Type filter — return items matching type
    if (type) {
      const filtered = FIXTURE_FULL_PAGE.items.filter((i) => i.type === type);
      return HttpResponse.json({
        ...FIXTURE_FULL_PAGE,
        items: filtered,
        totalItems: filtered.length,
        totalPages: 1,
      } as SearchResponse);
    }

    return HttpResponse.json(FIXTURE_FULL_PAGE);
  }),
];

export const searchErrorHandler = http.get(`${BASE_URL}/search`, () => {
  return HttpResponse.json({ code: "SEARCH_UNAVAILABLE" }, { status: 500 });
});
