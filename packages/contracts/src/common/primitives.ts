import { z } from "zod";

/**
 * Shared, dependency-light building blocks reused by every domain module.
 *
 * These are declared once at module scope (never constructed per-request) so
 * that Zod's internal schema compilation happens a single time at import,
 * keeping validation inside the 8ms budget on the 180ms p95 cache-hit search
 * path.
 */

// ---------------------------------------------------------------------------
// IATA airport code (BR-11)
// ---------------------------------------------------------------------------

/** Exact BR-11 wording — asserted verbatim by tests across every consumer. */
export const IATA_CODE_MESSAGE = "Airport code must be a valid 3-letter IATA code";

const IATA_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Accepts lowercase input and surrounding whitespace, normalises to
 * uppercase, then enforces the exact three-letter IATA shape. Anything that
 * still fails after normalisation is rejected with the BR-11 message.
 */
export const iataCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(IATA_CODE_PATTERN, { message: IATA_CODE_MESSAGE }));

export type IataCode = z.infer<typeof iataCode>;

// ---------------------------------------------------------------------------
// ISO-8601 date / date-time coercion
// ---------------------------------------------------------------------------

export const ISO_DATE_MESSAGE = "Date must be a valid ISO-8601 date-time string";

/**
 * Wire schemas never accept `z.date()` directly — a JSON payload has no
 * native Date type. Instead every date/datetime field accepts an ISO-8601
 * string (as produced by `Date.prototype.toISOString()` in the browser) and
 * pipes it through to a real `Date` instance, so a serialized-then-parsed
 * payload round-trips without any manual transformation by callers.
 */
export const isoDateString = z
  .string({ message: ISO_DATE_MESSAGE })
  .datetime({ message: ISO_DATE_MESSAGE, offset: true })
  .pipe(z.coerce.date());

export type IsoDate = z.infer<typeof isoDateString>;

// ---------------------------------------------------------------------------
// Currency code (ISO 4217)
// ---------------------------------------------------------------------------

export const CURRENCY_CODE_MESSAGE = "Currency must be a valid 3-letter ISO 4217 code";

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export const currencyCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(CURRENCY_CODE_PATTERN, { message: CURRENCY_CODE_MESSAGE }));

export type CurrencyCode = z.infer<typeof currencyCode>;

// ---------------------------------------------------------------------------
// Money (string or number, positive, <= 2 decimal places)
// ---------------------------------------------------------------------------

export const MONEY_POSITIVE_MESSAGE = "Amount must be greater than zero";
export const MONEY_PRECISION_MESSAGE = "Amount must not have more than two decimal places";
export const MONEY_INVALID_MESSAGE = "Amount must be a valid number";

const DECIMAL_STRING_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * Suppliers sometimes serialise money as strings (to dodge float artefacts
 * client-side); this platform re-validates and normalises server-side rather
 * than trusting either representation. Values with more than two decimal
 * places are rejected outright rather than silently rounded, so precision
 * loss never happens invisibly.
 */
export const positiveMoney = z.union([z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === "string" && !DECIMAL_STRING_PATTERN.test(value.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_PRECISION_MESSAGE });
    return z.NEVER;
  }

  const numeric = typeof value === "string" ? Number(value.trim()) : value;

  if (!Number.isFinite(numeric)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_INVALID_MESSAGE });
    return z.NEVER;
  }

  if (numeric <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_POSITIVE_MESSAGE });
    return z.NEVER;
  }

  const rounded = Math.round(numeric * 100) / 100;
  // A tolerance of 1e-9 comfortably absorbs ordinary IEEE-754 representation
  // error for two-decimal values (~1e-13) while still catching genuine
  // extra-precision input (e.g. 412.5678, whose rounded delta is ~1e-3).
  if (typeof value === "number" && Math.abs(rounded - numeric) > 1e-9) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: MONEY_PRECISION_MESSAGE });
    return z.NEVER;
  }

  return rounded;
});

export type PositiveMoney = z.infer<typeof positiveMoney>;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const IDENTIFIER_REQUIRED_MESSAGE = "Identifier must not be empty";

export const identifier = z.string().trim().min(1, { message: IDENTIFIER_REQUIRED_MESSAGE });

export type Identifier = z.infer<typeof identifier>;

export const CORRELATION_ID_REQUIRED_MESSAGE = "correlationId is required";

/** Every event schema requires this so a request can be traced end to end. */
export const correlationId = z.string().trim().min(1, { message: CORRELATION_ID_REQUIRED_MESSAGE });

export type CorrelationId = z.infer<typeof correlationId>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const paginationSchema = z
  .object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export type Pagination = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------------------
// Shared date-order refinement helper
// ---------------------------------------------------------------------------

/**
 * A date supplied for a future event (departure, pickup, ...) must be
 * strictly after "now". A value exactly equal to the current instant is
 * treated as NOT in the future — this is the documented, tested decision for
 * that boundary (see the edge-case test suite).
 */
export function isStrictlyFuture(value: Date, reference: Date = new Date()): boolean {
  return value.getTime() > reference.getTime();
}

export function isStrictlyAfter(later: Date, earlier: Date): boolean {
  return later.getTime() > earlier.getTime();
}

export function isOnOrAfter(later: Date, earlier: Date): boolean {
  return later.getTime() >= earlier.getTime();
}
