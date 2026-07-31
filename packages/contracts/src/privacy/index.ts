/**
 * Privacy / GDPR data-subject rights schemas.
 *
 * Covers the four rights endpoints on /v1/me:
 *   GET    /v1/me              — profile read
 *   PATCH  /v1/me              — profile rectification
 *   POST   /v1/me/export       — export request
 *   GET    /v1/me/export/{id}  — export status / download URL
 *   DELETE /v1/me              — erasure request
 *
 * All schemas use .strict() so an unexpected extra field is a contract
 * violation, not silent pass-through (policy from @travel/contracts).
 */
import { z } from "zod";
import { identifier, isoDateString } from "../common/primitives.js";

// ---------------------------------------------------------------------------
// Profile patch (PATCH /v1/me)
// ---------------------------------------------------------------------------

/**
 * Partial profile update — all fields optional; at least one must be present.
 * Server derives the subject identifier from the bearer token, never from the body.
 */
export const ProfilePatchSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .strict()
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "At least one field must be present in a profile patch" },
  );

export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

// ---------------------------------------------------------------------------
// Export request and status (POST + GET /v1/me/export)
// ---------------------------------------------------------------------------

export const ExportRequestSchema = z.object({}).strict();
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export const DataSubjectRequestStatusSchema = z.enum([
  "queued",
  "processing",
  "ready",
  "failed",
  "expired",
]);
export type DataSubjectRequestStatus = z.infer<typeof DataSubjectRequestStatusSchema>;

/** Response to POST /v1/me/export — 202 Accepted */
export const ExportAcceptedSchema = z
  .object({
    requestId: identifier,
    status: z.literal("queued"),
    estimatedCompletionAt: isoDateString,
  })
  .strict();
export type ExportAccepted = z.infer<typeof ExportAcceptedSchema>;

/** Response to GET /v1/me/export/{requestId} */
export const ExportStatusSchema = z
  .object({
    requestId: identifier,
    status: DataSubjectRequestStatusSchema,
    /** Present only when status === "ready" */
    downloadUrl: z.string().url().optional(),
    /** Present only when status === "ready" */
    expiresAt: isoDateString.optional(),
    /** Present when status === "failed" */
    errorReference: z.string().optional(),
    requestedAt: isoDateString,
    completedAt: isoDateString.optional(),
  })
  .strict();
export type ExportStatus = z.infer<typeof ExportStatusSchema>;

// ---------------------------------------------------------------------------
// Export archive manifest (the JSON structure of the export file itself)
// ---------------------------------------------------------------------------

/** Minimal payment record included in an export — no card numbers, no CVV. */
const ExportPaymentRecordSchema = z
  .object({
    providerReference: z.string(),
    cardBrand: z.string().optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    amount: z.string(),
    currency: z.string(),
    status: z.string(),
    createdAt: isoDateString,
  })
  .strict();

/** Booking summary in the export — offer snapshot, passenger list, status. */
const ExportBookingRecordSchema = z
  .object({
    bookingId: identifier,
    status: z.string(),
    offerSnapshot: z.record(z.string(), z.unknown()),
    passengers: z.array(z.record(z.string(), z.unknown())),
    payments: z.array(ExportPaymentRecordSchema),
    createdAt: isoDateString,
  })
  .strict();

/**
 * The full export archive manifest — top-level shape of the JSON file
 * uploaded to the export bucket.
 *
 * contract-tested via ExportArchiveManifestSchema.safeParse(archive).
 */
export const ExportArchiveManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    subjectId: identifier,
    exportedAt: isoDateString,
    requestId: identifier,
    account: z.record(z.string(), z.unknown()),
    preferences: z.record(z.string(), z.unknown()).nullable(),
    bookings: z.array(ExportBookingRecordSchema),
    itineraries: z.array(z.record(z.string(), z.unknown())),
    travelers: z.array(z.record(z.string(), z.unknown())),
    conversationHistory: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
export type ExportArchiveManifest = z.infer<typeof ExportArchiveManifestSchema>;

// ---------------------------------------------------------------------------
// Erasure request and response (DELETE /v1/me)
// ---------------------------------------------------------------------------

export const ErasureRequestSchema = z
  .object({
    /** Optional human-readable reason supplied by the subject. */
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;

/** An individual item in the erasure outcome — describes one data category. */
const ErasureOutcomeItemSchema = z
  .object({
    category: z.string(),
    table: z.string(),
    /** "erased_now" | "scheduled" | "retained" */
    disposition: z.enum(["erased_now", "scheduled", "retained"]),
    /** ISO-8601 date when the row will be physically purged (for "scheduled"). */
    purgeAfter: isoDateString.optional(),
    /** Reason the data is retained (for "retained" — e.g. "financial_record_7yr"). */
    retentionReason: z.string().optional(),
  })
  .strict();

export type ErasureOutcomeItem = z.infer<typeof ErasureOutcomeItemSchema>;

/** Response to DELETE /v1/me — 202 Accepted */
export const ErasureAcceptedSchema = z
  .object({
    requestId: identifier,
    scheduledPurgeAt: isoDateString,
    /** Categories erased immediately (crypto-erase or physical delete). */
    erasedNow: z.array(ErasureOutcomeItemSchema),
    /** Categories scheduled for physical purge after retention window. */
    scheduled: z.array(ErasureOutcomeItemSchema),
    /** Categories retained — includes reason codes for each. */
    retained: z.array(ErasureOutcomeItemSchema),
  })
  .strict();
export type ErasureAccepted = z.infer<typeof ErasureAcceptedSchema>;

// ---------------------------------------------------------------------------
// Data-subject request record (internal tracking table shape)
// ---------------------------------------------------------------------------

export const DataSubjectRequestTypeSchema = z.enum([
  "access",
  "export",
  "rectification",
  "erasure",
]);
export type DataSubjectRequestType = z.infer<typeof DataSubjectRequestTypeSchema>;

export const DataSubjectRequestSchema = z
  .object({
    id: identifier,
    userId: identifier,
    type: DataSubjectRequestTypeSchema,
    status: DataSubjectRequestStatusSchema,
    requestedAt: isoDateString,
    completedAt: isoDateString.optional(),
    outcomeSummary: z.record(z.string(), z.unknown()).nullable(),
    correlationId: z.string(),
  })
  .strict();
export type DataSubjectRequest = z.infer<typeof DataSubjectRequestSchema>;
