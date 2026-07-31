import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SORT_VALUES = [
  "recommended",
  "price_asc",
  "price_desc",
  "rating_desc",
  "distance_asc",
] as const;

export type SortOption = (typeof SORT_VALUES)[number];

export const SearchCriteriaSchema = z.object({
  destination: z.string().default(""),
  checkIn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  checkOut: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  guests: z.coerce.number().int().min(1).max(20).catch(1),
  rooms: z.coerce.number().int().min(1).max(10).catch(1),
  minPrice: z.coerce.number().min(0).optional().catch(undefined),
  maxPrice: z.coerce.number().min(0).optional().catch(undefined),
  minRating: z.coerce.number().min(0).max(5).optional().catch(undefined),
  amenities: z.array(z.string()).default([]),
  type: z.string().optional().catch(undefined),
  freeCancellation: z.boolean().optional().catch(undefined),
  sort: z.enum(SORT_VALUES).catch("recommended"),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(50).catch(20),
  currency: z.string().length(3).catch("USD"),
  locale: z.string().catch("en-US"),
});

export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;

// ---------------------------------------------------------------------------
// Parse URL search params → SearchCriteria (never throws)
// ---------------------------------------------------------------------------

export function parseSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): SearchCriteria {
  const raw: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;

    if (key === "amenities") {
      raw[key] = Array.isArray(value) ? value : [value];
    } else if (key === "freeCancellation") {
      // Only set to true when explicitly enabled; "false" and absent both → undefined
      if (value === "true" || value === "1") {
        raw[key] = true;
      }
      // else: omit — Zod optional catches undefined
    } else {
      raw[key] = Array.isArray(value) ? value[0] : value;
    }
  }

  return SearchCriteriaSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Serialise SearchCriteria → URLSearchParams (omits default values)
// ---------------------------------------------------------------------------

export function buildSearchParams(criteria: SearchCriteria): URLSearchParams {
  const params = new URLSearchParams();

  if (criteria.destination) params.set("destination", criteria.destination);
  if (criteria.checkIn) params.set("checkIn", criteria.checkIn);
  if (criteria.checkOut) params.set("checkOut", criteria.checkOut);
  if (criteria.guests !== 1) params.set("guests", String(criteria.guests));
  if (criteria.rooms !== 1) params.set("rooms", String(criteria.rooms));
  if (criteria.minPrice !== undefined) params.set("minPrice", String(criteria.minPrice));
  if (criteria.maxPrice !== undefined) params.set("maxPrice", String(criteria.maxPrice));
  if (criteria.minRating !== undefined) params.set("minRating", String(criteria.minRating));
  for (const a of criteria.amenities) params.append("amenities", a);
  if (criteria.type) params.set("type", criteria.type);
  if (criteria.freeCancellation) params.set("freeCancellation", "true");
  if (criteria.sort !== "recommended") params.set("sort", criteria.sort);
  if (criteria.page > 1) params.set("page", String(criteria.page));
  if (criteria.pageSize !== 20) params.set("pageSize", String(criteria.pageSize));
  if (criteria.currency !== "USD") params.set("currency", criteria.currency);
  if (criteria.locale !== "en-US") params.set("locale", criteria.locale);

  return params;
}

export function criteriaToQueryRecord(criteria: SearchCriteria): Record<string, unknown> {
  return {
    destination: criteria.destination || undefined,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    guests: criteria.guests,
    rooms: criteria.rooms,
    minPrice: criteria.minPrice,
    maxPrice: criteria.maxPrice,
    minRating: criteria.minRating,
    amenities: criteria.amenities.length > 0 ? criteria.amenities : undefined,
    type: criteria.type,
    freeCancellation: criteria.freeCancellation,
    sort: criteria.sort,
    page: criteria.page,
    pageSize: criteria.pageSize,
    currency: criteria.currency,
    locale: criteria.locale,
  };
}

// ---------------------------------------------------------------------------
// Filter reducer
// ---------------------------------------------------------------------------

export type FilterAction =
  | { type: "SET_DESTINATION"; payload: string }
  | { type: "SET_DATES"; payload: { checkIn?: string; checkOut?: string } }
  | { type: "SET_GUESTS"; payload: number }
  | { type: "SET_PRICE_RANGE"; payload: { min?: number; max?: number } }
  | { type: "SET_RATING"; payload: number | undefined }
  | { type: "TOGGLE_AMENITY"; payload: string }
  | { type: "SET_TYPE"; payload: string | undefined }
  | { type: "SET_FREE_CANCELLATION"; payload: boolean | undefined }
  | { type: "SET_SORT"; payload: SortOption }
  | { type: "SET_PAGE"; payload: number }
  | { type: "CLEAR_FILTERS" }
  | { type: "RESET"; payload: SearchCriteria };

export function filterReducer(state: SearchCriteria, action: FilterAction): SearchCriteria {
  switch (action.type) {
    case "SET_DESTINATION":
      return { ...state, destination: action.payload, page: 1 };
    case "SET_DATES":
      return { ...state, ...action.payload, page: 1 };
    case "SET_GUESTS":
      return { ...state, guests: action.payload, page: 1 };
    case "SET_PRICE_RANGE":
      return { ...state, minPrice: action.payload.min, maxPrice: action.payload.max, page: 1 };
    case "SET_RATING":
      return { ...state, minRating: action.payload, page: 1 };
    case "TOGGLE_AMENITY": {
      const has = state.amenities.includes(action.payload);
      return {
        ...state,
        amenities: has
          ? state.amenities.filter((a) => a !== action.payload)
          : [...state.amenities, action.payload],
        page: 1,
      };
    }
    case "SET_TYPE":
      return { ...state, type: action.payload, page: 1 };
    case "SET_FREE_CANCELLATION":
      return { ...state, freeCancellation: action.payload, page: 1 };
    case "SET_SORT":
      return { ...state, sort: action.payload, page: 1 };
    case "SET_PAGE":
      return { ...state, page: action.payload };
    case "CLEAR_FILTERS":
      return {
        ...state,
        minPrice: undefined,
        maxPrice: undefined,
        minRating: undefined,
        amenities: [],
        type: undefined,
        freeCancellation: undefined,
        sort: "recommended",
        page: 1,
      };
    case "RESET":
      return action.payload;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Active-filter detection (for chips + zero-result relaxation)
// ---------------------------------------------------------------------------

export interface ActiveFilter {
  key: string;
  label: string;
  action: FilterAction;
}

export function getActiveFilters(criteria: SearchCriteria): ActiveFilter[] {
  const filters: ActiveFilter[] = [];

  if (criteria.minPrice !== undefined || criteria.maxPrice !== undefined) {
    const label =
      criteria.minPrice !== undefined && criteria.maxPrice !== undefined
        ? `$${criteria.minPrice}–$${criteria.maxPrice}`
        : criteria.minPrice !== undefined
          ? `Min $${criteria.minPrice}`
          : `Max $${criteria.maxPrice}`;
    filters.push({ key: "price", label, action: { type: "SET_PRICE_RANGE", payload: {} } });
  }

  if (criteria.minRating !== undefined) {
    filters.push({
      key: "rating",
      label: `${criteria.minRating}+ stars`,
      action: { type: "SET_RATING", payload: undefined },
    });
  }

  for (const amenity of criteria.amenities) {
    filters.push({
      key: `amenity:${amenity}`,
      label: amenity,
      action: { type: "TOGGLE_AMENITY", payload: amenity },
    });
  }

  if (criteria.type) {
    filters.push({
      key: "type",
      label: criteria.type,
      action: { type: "SET_TYPE", payload: undefined },
    });
  }

  if (criteria.freeCancellation) {
    filters.push({
      key: "freeCancellation",
      label: "Free cancellation",
      action: { type: "SET_FREE_CANCELLATION", payload: undefined },
    });
  }

  return filters;
}

// ---------------------------------------------------------------------------
// Price formatting utility
// ---------------------------------------------------------------------------

export function formatPrice(amount: number, currency: string, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

// ---------------------------------------------------------------------------
// Night count utility (handles DST boundaries correctly)
// ---------------------------------------------------------------------------

export function computeNights(checkIn: string, checkOut: string): number {
  const msPerDay = 86_400_000;
  const inMs = new Date(checkIn).valueOf();
  const outMs = new Date(checkOut).valueOf();
  if (isNaN(inMs) || isNaN(outMs) || outMs <= inMs) return 0;
  return Math.round((outMs - inMs) / msPerDay);
}
