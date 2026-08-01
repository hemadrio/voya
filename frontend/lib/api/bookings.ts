/**
 * Bookings API client (WO-068, AC7).
 *
 * All requests send a stable Idempotency-Key header derived from the draft
 * so retries, refreshes, and duplicate submits never create duplicate bookings.
 *
 * POST /bookings — create booking (idempotent)
 * GET  /bookings/{bookingId}/status — poll booking status
 * POST /quotes/{quoteId}/revalidate — re-validate quote before payment
 * POST /promotions/validate — validate and apply promo code
 */

import { apiClient } from "./client.js";
import type { TravelerDetailsValues, ExtrasValues } from "../validation/checkout.js";

// ---------------------------------------------------------------------------
// Quote revalidation
// ---------------------------------------------------------------------------

export interface RevalidatedQuote {
  quoteId: string;
  expiresAt: string;
  total: number;
  lineItems: Array<{ code: string; label: string; amount: number }>;
  /** True when the total changed since the draft was created. */
  changed: boolean;
  previousTotal?: number;
}

export async function revalidateQuote(
  quoteId: string,
  signal?: AbortSignal,
): Promise<RevalidatedQuote> {
  return apiClient.post<RevalidatedQuote>(
    `/quotes/${encodeURIComponent(quoteId)}/revalidate`,
    {},
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Promo code validation
// ---------------------------------------------------------------------------

export interface PromoValidationResult {
  code: string;
  label: string;
  discountAmount: number;
  newTotal: number;
}

export async function validatePromoCode(
  promoCode: string,
  quoteId: string,
  signal?: AbortSignal,
): Promise<PromoValidationResult> {
  return apiClient.post<PromoValidationResult>(
    "/promotions/validate",
    { code: promoCode, quoteId },
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Create booking
// ---------------------------------------------------------------------------

export interface CreateBookingBody {
  draftId: string;
  quoteId: string;
  paymentIntentId: string;
  travelers: {
    primary: { firstName: string; lastName: string; email: string; phone: string };
    guests: Array<{ firstName: string; lastName: string; age: number }>;
  };
  specialRequests?: string;
  extras: Array<{ code: string; quantity: number }>;
  promoCode?: string;
  consents: { terms: boolean; cancellationPolicy: boolean; marketing: boolean };
}

export interface BookingCreatedResponse {
  bookingId: string;
  reference: string;
  status: "pending" | "confirmed";
  total: number;
  cancellationDeadline: string;
}

export async function createBooking(
  body: CreateBookingBody,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<BookingCreatedResponse> {
  return apiClient.post<BookingCreatedResponse>("/bookings", body, {
    signal,
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

// ---------------------------------------------------------------------------
// Booking status polling
// ---------------------------------------------------------------------------

export interface BookingStatusResponse {
  status: "pending" | "confirmed" | "failed";
  reference?: string;
  failureReason?: string;
}

export async function getBookingStatus(
  bookingId: string,
  signal?: AbortSignal,
): Promise<BookingStatusResponse> {
  return apiClient.get<BookingStatusResponse>(
    `/bookings/${encodeURIComponent(bookingId)}/status`,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Build booking body from draft step data
// ---------------------------------------------------------------------------

export function buildCreateBookingBody(
  draftId: string,
  quoteId: string,
  paymentIntentId: string,
  travelerDetails: TravelerDetailsValues,
  extras: ExtrasValues,
): CreateBookingBody {
  return {
    draftId,
    quoteId,
    paymentIntentId,
    travelers: {
      primary: {
        firstName: travelerDetails.primary.firstName,
        lastName: travelerDetails.primary.lastName,
        email: travelerDetails.primary.email,
        phone: travelerDetails.primary.phone,
      },
      guests: (travelerDetails.guests ?? []).map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        age: g.age,
      })),
    },
    specialRequests: travelerDetails.specialRequests,
    extras: (extras.extras ?? []).filter((e) => e.quantity > 0),
    promoCode: extras.promoCode || undefined,
    consents: {
      terms: travelerDetails.consents.terms,
      cancellationPolicy: travelerDetails.consents.cancellationPolicy,
      marketing: travelerDetails.consents.marketing,
    },
  };
}
