/**
 * Account API client (WO-069).
 *
 * Wrappers for:
 *  - GET  /account/bookings         — paginated bookings list
 *  - GET  /account/bookings/{id}    — booking detail
 *  - POST /account/bookings/{id}/cancellation/preview
 *  - POST /account/bookings/{id}/cancel  (Idempotency-Key)
 *  - POST /account/bookings/{id}/modification/preview
 *  - POST /account/bookings/{id}/modification
 *  - GET  /account/wishlist
 *  - DELETE /account/wishlist/{listingId}
 *  - GET/PATCH /account/profile
 *  - POST /account/password
 *  - POST /account/deletion
 *
 * Constraint: refund amounts, penalties, and price differences are NEVER
 * computed client-side. They are rendered only from backend preview responses.
 */

import { apiClient } from "./client.js";

// ---------------------------------------------------------------------------
// Booking types
// ---------------------------------------------------------------------------

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "pending_modification"
  | "cancelled"
  | "failed";

export interface BookingListItem {
  bookingId: string;
  reference: string;
  status: BookingStatus;
  listing: {
    id: string;
    slug: string;
    title: string;
    heroImage: string;
    location: string;
  };
  checkIn: string;
  checkOut: string;
  timezone: string;
  guests: { adults: number; children: number; infants: number };
  total: { currency: string; amount: number };
  cancellationDeadline: string;
  canCancel: boolean;
  canModify: boolean;
}

export interface BookingListResponse {
  items: BookingListItem[];
  page: number;
  totalPages: number;
}

export interface LineItem {
  code: string;
  label: string;
  amount: number;
  currency: string;
}

export interface Payment {
  id: string;
  method: string;
  last4: string;
  amount: number;
  capturedAt: string;
  receiptUrl: string;
}

export interface Policy {
  type: string;
  label: string;
  description: string;
}

export interface BookingDetail extends BookingListItem {
  lineItems: LineItem[];
  payments: Payment[];
  policies: Policy[];
  host: { name: string; contactAvailableFrom: string };
  voucherUrl: string;
}

// ---------------------------------------------------------------------------
// Cancellation types
// ---------------------------------------------------------------------------

export interface CancellationPreview {
  refundableAmount: number;
  nonRefundableAmount: number;
  penalties: Array<{ label: string; amount: number }>;
  currency: string;
  settlementEtaDays: number;
}

export interface CancellationResult {
  status: "cancelled";
  refund: { amount: number; currency: string; settlementEtaDays: number };
}

// ---------------------------------------------------------------------------
// Modification types
// ---------------------------------------------------------------------------

export interface ModificationPreviewRequest {
  checkIn: string;
  checkOut: string;
  guests: { adults: number; children: number; infants: number };
}

export interface ModificationPreview {
  available: boolean;
  priceDifference: { amount: number; currency: string };
  newTotal: number;
}

export interface ModificationResult {
  status: "pending_modification";
}

// ---------------------------------------------------------------------------
// Wishlist types
// ---------------------------------------------------------------------------

export interface WishlistItem {
  listingId: string;
  listingSlug: string;
  title: string;
  heroImage: string;
  location: string;
  priceFrom?: number;
  currency?: string;
  available: boolean;
  savedAt: string;
}

export interface WishlistResponse {
  items: WishlistItem[];
}

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  locale: string;
  currency: string;
  marketingOptIn: boolean;
}

export interface ProfileUpdateRequest {
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatarUrl?: string;
  locale?: string;
  currency?: string;
  marketingOptIn?: boolean;
}

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}

export interface DeletionResult {
  status: "pending_deletion";
  effectiveAt: string;
}

// ---------------------------------------------------------------------------
// Bookings API
// ---------------------------------------------------------------------------

export async function listBookings(
  params: { status?: BookingStatus; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<BookingListResponse> {
  const query: Record<string, unknown> = {};
  if (params.status) query.status = params.status;
  if (params.page) query.page = params.page;
  if (params.pageSize) query.pageSize = params.pageSize;

  const path = Object.keys(query).length
    ? `/account/bookings?${new URLSearchParams(
        Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      )}`
    : "/account/bookings";

  return apiClient.get<BookingListResponse>(path, { signal });
}

export async function getBooking(
  bookingId: string,
  signal?: AbortSignal,
): Promise<BookingDetail> {
  return apiClient.get<BookingDetail>(
    `/account/bookings/${encodeURIComponent(bookingId)}`,
    { signal },
  );
}

export async function previewCancellation(
  bookingId: string,
  signal?: AbortSignal,
): Promise<CancellationPreview> {
  return apiClient.post<CancellationPreview>(
    `/account/bookings/${encodeURIComponent(bookingId)}/cancellation/preview`,
    {},
    { signal },
  );
}

export async function cancelBooking(
  bookingId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CancellationResult> {
  return apiClient.post<CancellationResult>(
    `/account/bookings/${encodeURIComponent(bookingId)}/cancel`,
    {},
    { signal, headers: { "Idempotency-Key": idempotencyKey } },
  );
}

export async function previewModification(
  bookingId: string,
  body: ModificationPreviewRequest,
  signal?: AbortSignal,
): Promise<ModificationPreview> {
  return apiClient.post<ModificationPreview>(
    `/account/bookings/${encodeURIComponent(bookingId)}/modification/preview`,
    body,
    { signal },
  );
}

export async function requestModification(
  bookingId: string,
  body: ModificationPreviewRequest,
  signal?: AbortSignal,
): Promise<ModificationResult> {
  return apiClient.post<ModificationResult>(
    `/account/bookings/${encodeURIComponent(bookingId)}/modification`,
    body,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Wishlist API
// ---------------------------------------------------------------------------

export async function listWishlist(signal?: AbortSignal): Promise<WishlistResponse> {
  return apiClient.get<WishlistResponse>("/account/wishlist", { signal });
}

export async function removeWishlistItem(
  listingId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiClient.delete<void>(
    `/account/wishlist/${encodeURIComponent(listingId)}`,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Profile API
// ---------------------------------------------------------------------------

export async function getProfile(signal?: AbortSignal): Promise<Profile> {
  return apiClient.get<Profile>("/account/profile", { signal });
}

export async function updateProfile(
  body: ProfileUpdateRequest,
  signal?: AbortSignal,
): Promise<Profile> {
  return apiClient.patch<Profile>("/account/profile", body, { signal });
}

export async function changePassword(
  body: PasswordChangeRequest,
  signal?: AbortSignal,
): Promise<void> {
  return apiClient.post<void>("/account/password", body, { signal });
}

export async function requestAccountDeletion(
  signal?: AbortSignal,
): Promise<DeletionResult> {
  return apiClient.post<DeletionResult>("/account/deletion", {}, { signal });
}
