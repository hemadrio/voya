/**
 * @travel/contracts — Trip document domain schemas (WO-054).
 *
 * Security invariant: TripDocumentViewModel and TravellerViewModel have NO
 * field capable of carrying dateOfBirth, passportNumber, or a full payment
 * identifier.  Exposure of Restricted PII is a compile-time impossibility,
 * not a runtime filter.
 *
 * API surface:
 *   POST /v1/itineraries/{id}/documents  → PostDocumentResponse (201/202)
 *   GET  /v1/itineraries/{id}/documents/{documentId} → GetDocumentResponse
 */

import { z } from "zod";
import { identifier, isoDateString, currencyCode } from "../common/primitives.js";

// ---------------------------------------------------------------------------
// Document status enum
// ---------------------------------------------------------------------------

export const DocumentStatusSchema = z.enum(["PENDING", "READY", "FAILED"]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

// ---------------------------------------------------------------------------
// TravellerViewModel — allow-listed name fields ONLY.
//
// dateOfBirth and passportNumber are deliberately absent — not filtered at
// runtime but structurally non-existent in this type.
// ---------------------------------------------------------------------------

export const TravellerViewModelSchema = z
  .object({
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    // No dateOfBirth. No passportNumber. No documentType. By design.
  })
  .strict();

export type TravellerViewModel = z.infer<typeof TravellerViewModelSchema>;

// ---------------------------------------------------------------------------
// BookingDocumentViewModel — traveller-facing booking summary.
//
// confirmationReference is the traveller-facing booking code only.
// No PaymentIntent id, no provider transaction reference, no full PAN.
// cardBrand + cardLast4 may appear if payment context is shown; full card
// details are structurally absent.
// ---------------------------------------------------------------------------

export const BookingDocumentViewModelSchema = z
  .object({
    id: identifier,
    bookingType: z.string(),
    status: z.string(),
    supplier: z.string().optional(),
    confirmationReference: z.string().optional(),
    travelStartDate: z.string().optional(),
    travelEndDate: z.string().optional(),
    origin: z.string().optional(),
    destination: z.string().optional(),
    price: z.string(),
    currency: currencyCode,
    travellers: z.array(TravellerViewModelSchema),
    // No dateOfBirth, no passportNumber, no documentType on any traveller.
    // No paymentIntentId, no fullPan, no providerTransactionReference.
  })
  .strict();

export type BookingDocumentViewModel = z.infer<typeof BookingDocumentViewModelSchema>;

// ---------------------------------------------------------------------------
// CurrencyTotalViewModel
// ---------------------------------------------------------------------------

export const DocumentCurrencyTotalSchema = z
  .object({
    currency: currencyCode,
    amount: z.string(),
  })
  .strict();

export type DocumentCurrencyTotal = z.infer<typeof DocumentCurrencyTotalSchema>;

// ---------------------------------------------------------------------------
// TripDocumentViewModel — the full allow-listed view model fed to the renderer.
//
// This is a sealed type: no field references dateOfBirth, passportNumber,
// paymentIntentId, fullPan, or any payment identifier beyond confirmationCode.
// ---------------------------------------------------------------------------

export const TripDocumentViewModelSchema = z
  .object({
    documentId: identifier,
    itineraryId: identifier,
    itineraryName: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    generatedAt: z.string(),
    locale: z.string().default("en"),
    bookings: z.array(BookingDocumentViewModelSchema),
    totals: z.array(DocumentCurrencyTotalSchema),
  })
  .strict();

export type TripDocumentViewModel = z.infer<typeof TripDocumentViewModelSchema>;

// ---------------------------------------------------------------------------
// API request schemas
// ---------------------------------------------------------------------------

export const PostDocumentRequestSchema = z
  .object({
    locale: z.string().optional().default("en"),
  })
  .strict();

export type PostDocumentRequest = z.infer<typeof PostDocumentRequestSchema>;

// ---------------------------------------------------------------------------
// API response schemas
// ---------------------------------------------------------------------------

/**
 * Response for POST (201) and GET.
 * downloadUrl is only present when status === "READY".
 * downloadUrl is a short-lived pre-signed URL — it must never be logged.
 */
export const DocumentResponseSchema = z
  .object({
    documentId: identifier,
    status: DocumentStatusSchema,
    /** Pre-signed URL, present only when READY. Max 15-minute expiry. Never logged. */
    downloadUrl: z.string().url().optional(),
    expiresAt: z.string().optional(),
    generatedAt: z.string().optional(),
  })
  .strict();

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

// ---------------------------------------------------------------------------
// Send document request / response schemas — WO-055
// ---------------------------------------------------------------------------

/**
 * POST /v1/itineraries/{id}/documents/send request body.
 *
 * No `recipient` field — the recipient is resolved server-side from the
 * authenticated user's verified email.  Any client-supplied recipient would
 * be silently ignored; the schema enforces this at validation time.
 */
export const SendDocumentRequestSchema = z
  .object({
    locale: z.string().optional().default("en"),
  })
  .strict();

export type SendDocumentRequest = z.infer<typeof SendDocumentRequestSchema>;

/**
 * POST /v1/itineraries/{id}/documents/send 202 response body.
 *
 * `requestId`  — UUID generated per request for support tracing.
 * `eventId`    — deterministic UUID derived from itineraryId + time bucket;
 *                reused within the dedup window to suppress duplicate emails.
 * `status`     — always "QUEUED" on 202.
 * `reference`  — correlation/trace ID from the inbound request.
 */
export const SendDocumentResponseSchema = z
  .object({
    requestId: identifier,
    eventId: z.string().uuid(),
    status: z.literal("QUEUED"),
    reference: z.string().optional(),
  })
  .strict();

export type SendDocumentResponse = z.infer<typeof SendDocumentResponseSchema>;
