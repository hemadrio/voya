/**
 * Listings API wrappers — typed access to the listing detail, availability,
 * quote, and review endpoints (WO-067).
 */

import { apiClient } from "./client.js";

// ---------------------------------------------------------------------------
// Listing detail types
// ---------------------------------------------------------------------------

export interface ListingImage {
  url: string;
  blurHash: string;
  width: number;
  height: number;
  alt: string;
}

export interface ListingAmenity {
  code: string;
  label: string;
  group: string;
}

export interface ApproximateLocation {
  lat: number;
  lng: number;
  radiusMeters: number;
  city: string;
  country: string;
}

export interface ListingHost {
  id: string;
  name: string;
  avatarUrl: string;
  joinedAt: string;
  responseRate: number;
  verified: boolean;
}

export interface CancellationPolicy {
  type: string;
  description: string;
  deadlineHours: number;
}

export interface ListingPolicies {
  cancellation: CancellationPolicy;
  checkInFrom: string;
  checkOutBy: string;
  houseRules: string[];
}

export interface RatingCategory {
  code: string;
  average: number;
}

export interface ListingRating {
  average: number;
  count: number;
  categories: RatingCategory[];
}

export interface ListingDetail {
  id: string;
  slug: string;
  title: string;
  type: string;
  status: string;
  description: string;
  highlights: string[];
  amenities: ListingAmenity[];
  images: ListingImage[];
  approximateLocation: ApproximateLocation;
  host: ListingHost;
  policies: ListingPolicies;
  rating: ListingRating;
  minimumStay: number;
  maximumStay?: number;
  maxGuests: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Availability types
// ---------------------------------------------------------------------------

export interface BlockedRange {
  start: string;
  end: string;
  reason: "minimum_stay" | "blocked" | "booked" | string;
}

export interface AvailabilityResponse {
  blockedRanges: BlockedRange[];
  minimumStayByDate: Record<string, number>;
  checkInAllowedDays: number[];
}

// ---------------------------------------------------------------------------
// Quote types
// ---------------------------------------------------------------------------

export interface QuoteLineItem {
  code: string;
  label: string;
  amount: number;
}

export interface QuoteDiscount {
  code: string;
  label: string;
  amount: number;
}

export interface QuoteTax {
  label: string;
  amount: number;
}

export interface QuoteResponse {
  quoteId: string;
  expiresAt: string;
  currency: string;
  nights: number;
  nightlyRate: number;
  lineItems: QuoteLineItem[];
  discounts: QuoteDiscount[];
  taxes: QuoteTax[];
  total: number;
}

export interface QuoteRequest {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Review types
// ---------------------------------------------------------------------------

export interface ReviewAuthor {
  name: string;
  avatarUrl: string;
}

export interface ReviewCategoryRating {
  code: string;
  average: number;
}

export interface Review {
  id: string;
  author: ReviewAuthor;
  rating: number;
  categories: ReviewCategoryRating[];
  createdAt: string;
  body: string;
  hostReply?: string;
}

export interface ReviewsResponse {
  items: Review[];
  nextCursor: string | null;
}

export type ReviewSort = "newest" | "highest" | "lowest" | "relevance";

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

export async function getListing(
  slug: string,
  signal?: AbortSignal,
): Promise<ListingDetail> {
  return apiClient.get<ListingDetail>(`/listings/${slug}`, { signal });
}

export async function getAvailability(
  listingId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<AvailabilityResponse> {
  return apiClient.get<AvailabilityResponse>(`/listings/${listingId}/availability`, {
    params: { from, to },
    signal,
  });
}

export async function getQuote(
  listingId: string,
  body: QuoteRequest,
  signal?: AbortSignal,
): Promise<QuoteResponse> {
  return apiClient.post<QuoteResponse>(`/listings/${listingId}/quote`, body, { signal });
}

export async function getReviews(
  listingId: string,
  options: {
    cursor?: string;
    sort?: ReviewSort;
    minRating?: number;
  },
  signal?: AbortSignal,
): Promise<ReviewsResponse> {
  return apiClient.get<ReviewsResponse>(`/listings/${listingId}/reviews`, {
    params: options,
    signal,
  });
}
