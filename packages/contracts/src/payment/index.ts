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
