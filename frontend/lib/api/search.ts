import { apiClient } from "./client.js";
import type { SearchCriteria } from "../search/params.js";
import { criteriaToQueryRecord } from "../search/params.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface SearchLocation {
  city: string;
  country: string;
  lat: number;
  lng: number;
}

export interface SearchHeroImage {
  url: string;
  blurHash: string;
}

export interface SearchRating {
  average: number;
  count: number;
}

export interface SearchPrice {
  currency: string;
  nightly: number;
  total: number;
  nights: number;
  taxesIncluded: boolean;
}

export interface SearchResultItem {
  id: string;
  slug: string;
  title: string;
  type: string;
  location: SearchLocation;
  heroImage: SearchHeroImage;
  rating: SearchRating;
  amenities: string[];
  price: SearchPrice;
  freeCancellation: boolean;
  wishlisted: boolean;
}

export interface PriceHistogramBucket {
  bucket: number;
  count: number;
}

export interface AmenityFacet {
  value: string;
  label: string;
  count: number;
}

export interface RatingFacet {
  min: number;
  count: number;
}

export interface TypeFacet {
  value: string;
  count: number;
}

export interface SearchFacets {
  priceHistogram: PriceHistogramBucket[];
  amenities: AmenityFacet[];
  ratings: RatingFacet[];
  types: TypeFacet[];
}

export interface SearchResponse {
  items: SearchResultItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  facets: SearchFacets;
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

export async function fetchSearch(
  criteria: SearchCriteria,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return apiClient.get<SearchResponse>("/search", {
    params: criteriaToQueryRecord(criteria),
    signal,
  });
}
