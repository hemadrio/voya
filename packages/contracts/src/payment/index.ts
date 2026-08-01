import { z } from "zod";
import { currencyCode, identifier } from "../common/primitives.js";
import { PaymentStatusSchema } from "../common/enums.js";

// ---------------------------------------------------------------------------
// Minor-units helper
// ---------------------------------------------------------------------------

/**
 * Convert a decimal price string or number to integer minor units (e.g. cents).
 *
 * Uses Math.round to absorb IEEE-754 representation errors on two-decimal
 * values. Always returns a safe integer.
 *
 * @example toMinorUnits(412.50, 100) → 41250n
 */
export function toMinorUnits(
  amount: number | string,
  multiplier: number = 100,
): bigint {
  const numeric = typeof amount === "string" ? Number(amount) : amount;
  return BigInt(Math.round(numeric * multiplier));
}

/**
 * Convert integer minor units back to a decimal amount (e.g. cents → dollars).
 */
export function fromMinorUnits(
  amountMinor: bigint,
  divisor: number = 100,
): number {
  return Number(amountMinor) / divisor;
}

// ---------------------------------------------------------------------------
// Request schema — WO-045
//
// The client supplies only bookingId + currency; the platform derives the
// amount server-side from the re-validated booking snapshot.  A client-
// supplied amount is explicitly NOT accepted (AC5: mismatch logged at warn).
// ---------------------------------------------------------------------------

/**
 * POST /v1/payments/intents request body.
 *
 * `bookingId`  — the PENDING booking to create an intent for.
 * `currency`   — ISO 4217 currency code; must match the booking's currency.
 *
 * Intentionally omits `amount` — the platform derives it from the re-validated
 * booking snapshot to prevent the client from dictating the charge amount.
 */
export const PaymentIntentRequestSchema = z
  .object({
    bookingId: identifier,
    currency: currencyCode,
  })
  .strict();

export type PaymentIntentRequest = z.infer<typeof PaymentIntentRequestSchema>;

// ---------------------------------------------------------------------------
// Response schema — WO-045
// ---------------------------------------------------------------------------

/**
 * POST /v1/payments/intents 201 response body.
 *
 * `clientSecret`  — the only value the browser needs for Stripe hosted fields.
 * `amountMinor`   — the charge amount in the currency's minor unit (e.g. cents).
 *                   Returned as a number for JSON compatibility (safe integer).
 * `currency`      — ISO 4217 currency code.
 * `status`        — current PaymentIntent status from Stripe.
 * `paymentId`     — platform payment row UUID (not the Stripe intent ID).
 * `reference`     — correlation / trace ID echoed back for client diagnostics.
 *
 * The Stripe secret key and full intent object are NEVER returned.
 */
export const PaymentIntentResponseSchema = z
  .object({
    clientSecret: z.string().trim().min(1),
    amountMinor: z.number().int().positive(),
    currency: currencyCode,
    status: PaymentStatusSchema,
    paymentId: identifier,
    reference: z.string().optional(),
  })
  .strict();

export type PaymentIntentResponse = z.infer<typeof PaymentIntentResponseSchema>;

// ---------------------------------------------------------------------------
// Minor-unit guard helper (WO-049)
// ---------------------------------------------------------------------------

/**
 * Assert that a value is a safe-integer bigint (no fractional component).
 * Throws a TypeError if the value is null, undefined, fractional, or negative
 * when `allowZero` is false.
 *
 * AC9: all money arithmetic uses integer minor units; this helper is the
 * single enforcement point for the no-float constraint.
 */
export function assertIntegerMinorUnits(
  value: unknown,
  fieldName = "amountMinor",
): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `${fieldName} must be an integer minor-unit amount; received ${value}`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new TypeError(
        `${fieldName} must be an integer minor-unit amount; received "${value}"`,
      );
    }
    return BigInt(n);
  }
  throw new TypeError(
    `${fieldName} must be a bigint or integer; received ${String(value)}`,
  );
}

// ---------------------------------------------------------------------------
// Refund schemas — WO-049
// ---------------------------------------------------------------------------

/**
 * POST /v1/payments/refunds request body.
 *
 * `bookingId`    — the CONFIRMED booking to refund.
 * `amountMinor`  — amount to refund in the currency's minor unit; omit for a full refund.
 * `currency`     — ISO 4217 currency code; must match the original charge.
 * `reason`       — human-readable reason for the refund (logged in audit row).
 * `legId`        — optional leg identifier for split/partial refunds.
 */
export const RefundRequestSchema = z
  .object({
    bookingId: identifier,
    amountMinor: z.number().int().positive().optional(),
    currency: currencyCode,
    reason: z.string().trim().min(1).max(512),
    legId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type RefundRequest = z.infer<typeof RefundRequestSchema>;

/**
 * POST /v1/payments/refunds 201 response body.
 *
 * `refundId`        — platform refund payment row UUID.
 * `providerReference` — Stripe refund ID (e.g. "re_3...").
 * `amountMinor`     — refunded amount in the currency's minor unit.
 * `currency`        — ISO 4217 currency code.
 * `status`          — refund status: SUCCEEDED | PENDING | FAILED.
 * `settlementWindow` — human-readable settlement window sourced from config template.
 * `reference`       — correlation/trace ID echoed back for client diagnostics.
 */
export const RefundResponseSchema = z
  .object({
    refundId: identifier,
    providerReference: z.string().trim().min(1),
    amountMinor: z.number().int().positive(),
    currency: currencyCode,
    status: z.enum(["SUCCEEDED", "PENDING", "FAILED"]),
    settlementWindow: z.string().trim().min(1),
    reference: z.string().optional(),
  })
  .strict();

export type RefundResponse = z.infer<typeof RefundResponseSchema>;

// ---------------------------------------------------------------------------
// Reconciliation report schemas — WO-050
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON report written to S3 per reconciliation run (AC5).
 *
 * Contains no card data, no email addresses, and no personal identifiers
 * beyond internal booking IDs (which appear only in exception detail — not
 * in the top-level report shape below).
 */
export const ReconciliationReportSchema = z
  .object({
    periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    transactionsCompared: z.number().int().nonnegative(),
    exceptionsByKind: z.record(z.string(), z.number().int().nonnegative()),
    exceptionCount: z.number().int().nonnegative(),
    cleanRun: z.boolean(),
    correctTerminalStatePercent: z.number().min(0).max(100),
    generatedAt: z.string().datetime(),
  })
  .strict();

export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

/**
 * GET /v1/payments/reconciliation/runs response (operator endpoint, support_agent role only).
 */
export const ReconciliationRunSummarySchema = z
  .object({
    id: identifier,
    periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(["RUNNING", "COMPLETED", "FAILED", "PARTIAL"]),
    transactionsCompared: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
    cleanRun: z.boolean(),
    reportS3Key: z.string().nullable(),
  })
  .strict();

export const ReconciliationRunsResponseSchema = z
  .object({
    runs: z.array(ReconciliationRunSummarySchema),
    reference: z.string().optional(),
  })
  .strict();

export type ReconciliationRunSummary = z.infer<typeof ReconciliationRunSummarySchema>;
export type ReconciliationRunsResponse = z.infer<typeof ReconciliationRunsResponseSchema>;
