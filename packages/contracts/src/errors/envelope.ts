import { z } from "zod";

/**
 * Platform-wide error envelope.
 *
 * Every service and HTTP status returns exactly this shape — no additional
 * top-level keys are permitted (`.strict()` enforces this).  The `reference`
 * field equals the active trace / correlation identifier so a traveler's
 * screenshot resolves directly to an X-Ray trace or log stream.
 *
 * JSON wire shape:
 * ```json
 * {
 *   "error": {
 *     "code": "VALIDATION_FAILED",
 *     "message": "Airport code must be a valid 3-letter IATA code",
 *     "field": "origin"
 *   },
 *   "reference": "01j3h4k-7f2a9b"
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Error detail (nested object)
// ---------------------------------------------------------------------------

export const ErrorDetailSchema = z
  .object({
    /** Value from the ErrorCode union. */
    code: z.string(),
    /** Human-readable, actionable message safe to display to the client. */
    message: z.string(),
    /**
     * Dotted path to the offending input field (e.g. `"passengers.0.passportNumber"`).
     * Present only when the error is attributable to a specific field.
     */
    field: z.string().optional(),
  })
  .strict();

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

// ---------------------------------------------------------------------------
// Top-level envelope
// ---------------------------------------------------------------------------

export const ErrorEnvelopeSchema = z
  .object({
    /** Nested error object — code, message, and optional field. */
    error: ErrorDetailSchema,
    /**
     * Correlation / trace identifier for support triage.  Always populated —
     * falls back to a locally generated sortable identifier when no trace
     * context is available.
     */
    reference: z.string().min(1),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
