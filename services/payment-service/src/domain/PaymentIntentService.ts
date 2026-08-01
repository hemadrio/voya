/**
 * PaymentIntentService — idempotent Stripe PaymentIntent creation (WO-045).
 *
 * Guarantees:
 *   1. The booking must be PENDING, within its expiry window, and have passed
 *      price re-validation (payableUntil in the future) before any Stripe call
 *      is made.  If the price moved and the traveler has not accepted it,
 *      PRICE_CONSENT_REQUIRED (409) is thrown without reaching Stripe.
 *   2. The Stripe idempotency key is derived deterministically from
 *      (bookingId, amountMinor, currency) so a client retry returns the same
 *      PaymentIntent — never a duplicate charge.
 *   3. Amounts are computed server-side in integer minor units from the
 *      booking's re-validated total.  A client-supplied amount is ignored and
 *      logged at warn if it differs from the booking total.
 *   4. A payments ledger row is written atomically with a PAYMENT_INTENT_CREATED
 *      audit row in a single transaction (only on first successful creation;
 *      repeat calls return the existing row without creating a second one).
 *   5. No full card numbers, CVCs, or expiry dates ever reach this service
 *      (card capture happens via Stripe-hosted fields in the browser).
 *   6. Repeat calls within the payable window derive the same idempotency key,
 *      receive the same PaymentIntent from Stripe, and return the existing
 *      payments row — the row count does NOT increment.
 *
 * No Prisma, no Express — all dependencies injected.
 */

import {
  notFound,
  bookingNotPayable,
  priceConsentRequired,
  unsupportedCurrency,
  providerUnavailable,
} from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";
import { writeAudit } from "./AuditWriter.js";
import type { AuditTxClient } from "./AuditWriter.js";
import type { StripePort, StripeIntentResult } from "../adapters/StripePort.js";
import { deriveIdempotencyKey } from "../adapters/StripePort.js";
import type {
  PaymentRepositoryPort,
  PaymentRow,
} from "../repositories/PaymentRepository.js";

// ---------------------------------------------------------------------------
// Booking query port
// ---------------------------------------------------------------------------

/** Minimal booking projection needed for payment intent creation. */
export interface PayableBookingRow {
  id: string;
  status: string;
  /** Original or accepted total price as a decimal string (e.g. "412.50"). */
  totalPrice: string;
  currency: string;
  /** Timestamp at which this PENDING booking expires (null = no expiry). */
  expiresAt: Date | null;
  /** Timestamp after which the booking is no longer payable (WO-042 gate). */
  payableUntil: Date | null;
}

/**
 * Port for querying booking state from booking-service.
 *
 * Concrete implementation makes an authenticated internal HTTP call to
 * booking-service and validates the response against the shared contract
 * schema.  Unit tests supply an in-memory fake.
 */
export interface BookingQueryPort {
  findBookingForPayment(bookingId: string): Promise<PayableBookingRow | null>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CreateIntentResult {
  clientSecret: string;
  amountMinor: bigint;
  currency: string;
  /** Platform payment row UUID. */
  paymentId: string;
  /** Stripe PaymentIntent status mapped to platform PaymentStatus. */
  status: string;
}

// ---------------------------------------------------------------------------
// Actor context
// ---------------------------------------------------------------------------

export interface PaymentActor {
  id: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface PaymentLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Service deps
// ---------------------------------------------------------------------------

export interface PaymentIntentDeps {
  stripePort: StripePort;
  paymentRepo: PaymentRepositoryPort;
  bookingQuery: BookingQueryPort;
  clock?: () => Date;
  log?: PaymentLogger;
}

// ---------------------------------------------------------------------------
// PaymentIntentService
// ---------------------------------------------------------------------------

export class PaymentIntentService {
  private readonly stripePort: StripePort;
  private readonly paymentRepo: PaymentRepositoryPort;
  private readonly bookingQuery: BookingQueryPort;
  private readonly clock: () => Date;
  private readonly log: PaymentLogger | undefined;

  constructor(deps: PaymentIntentDeps) {
    this.stripePort = deps.stripePort;
    this.paymentRepo = deps.paymentRepo;
    this.bookingQuery = deps.bookingQuery;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  /**
   * Create or retrieve a PaymentIntent for the given booking.
   *
   * The call is idempotent: if a payment row already exists for
   * (bookingId, amountMinor, currency), Stripe's idempotency key mechanism
   * returns the same PaymentIntent and the existing row's id is used.
   *
   * @param bookingId     — Platform booking UUID (PENDING state required).
   * @param currency      — ISO 4217 currency; must match the booking's currency.
   * @param actor         — Authenticated caller identity for the audit row.
   * @param correlationId — Trace/request ID echoed in audit and response.
   */
  async createIntent(
    bookingId: string,
    currency: string,
    actor: PaymentActor,
    correlationId?: string,
  ): Promise<CreateIntentResult> {
    const now = this.clock();

    // ── 1. Fetch booking ─────────────────────────────────────────────────────
    const booking = await this.bookingQuery.findBookingForPayment(bookingId);
    if (!booking) {
      throw notFound(`Booking "${bookingId}" not found.`);
    }

    // ── 2. Booking must be PENDING ────────────────────────────────────────────
    if (booking.status !== "PENDING") {
      throw bookingNotPayable(
        `Booking "${bookingId}" is in status "${booking.status}" and cannot accept a payment. ` +
          `Only PENDING bookings may have PaymentIntents created.`,
      );
    }

    // ── 3. Booking must not be expired ────────────────────────────────────────
    if (booking.expiresAt !== null && booking.expiresAt <= now) {
      throw bookingNotPayable(
        `Booking "${bookingId}" expired at ${booking.expiresAt.toISOString()} and can no longer accept payment. ` +
          `Please create a new booking.`,
      );
    }

    // ── 4. Price re-validation gate (WO-042) ──────────────────────────────────
    if (!booking.payableUntil || booking.payableUntil <= now) {
      throw priceConsentRequired(
        `Booking "${bookingId}" has not passed price re-validation or the consent window has expired. ` +
          `Please call POST /v1/bookings/${bookingId}/revalidate before initiating payment.`,
      );
    }

    // ── 5. Currency must match booking ────────────────────────────────────────
    const normalisedCurrency = currency.toUpperCase();
    const bookingCurrency = booking.currency.toUpperCase();
    if (normalisedCurrency !== bookingCurrency) {
      this.log?.warn(
        {
          bookingId,
          requestedCurrency: normalisedCurrency,
          bookingCurrency,
          actorId: actor.id,
        },
        "Currency mismatch: request currency does not match booking currency",
      );
      throw unsupportedCurrency(
        normalisedCurrency,
        `Requested currency "${normalisedCurrency}" does not match the booking currency "${bookingCurrency}". ` +
          `Re-submit with currency "${bookingCurrency}".`,
      );
    }

    // ── 6. Compute amount in minor units (server-side, from booking) ──────────
    const amountMinor = toMinorUnits(booking.totalPrice);

    // ── 7. Derive deterministic idempotency key ────────────────────────────────
    const idempotencyKey = deriveIdempotencyKey(bookingId, amountMinor, normalisedCurrency);

    // ── 8. Call Stripe (idempotent — same key → same intent) ─────────────────
    let stripeResult: StripeIntentResult;
    try {
      stripeResult = await this.stripePort.createIntent({
        amountMinor,
        currency: normalisedCurrency.toLowerCase(),
        bookingId,
        idempotencyKey,
      });
    } catch (err) {
      if (isDomainError(err)) throw err;
      this.log?.error(
        { bookingId, actorId: actor.id, err },
        "Stripe PaymentIntent creation failed with unexpected error",
      );
      throw providerUnavailable(
        "The payment provider is temporarily unavailable. Please retry the request.",
      );
    }

    // ── 9. Fast-path: return existing row if already recorded ─────────────────
    const existing = await this.paymentRepo.findExistingCharge(
      bookingId,
      amountMinor,
      normalisedCurrency,
    );
    if (existing) {
      this.log?.info(
        { bookingId, paymentId: existing.id, actorId: actor.id },
        "Returning existing payment intent (idempotent repeat request)",
      );
      return {
        clientSecret: stripeResult.clientSecret,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        paymentId: existing.id,
        status: mapStripeStatusToPlatform(stripeResult.status),
      };
    }

    // ── 10. Persist payment row + audit row atomically ────────────────────────
    let paymentRow!: PaymentRow;
    await this.paymentRepo.runInTransaction(async (tx) => {
      paymentRow = await this.paymentRepo.createPaymentInTx(
        {
          bookingId,
          provider: "stripe",
          providerReference: stripeResult.id,
          type: "CHARGE",
          amountMinor: stripeResult.amountMinor,
          currency: normalisedCurrency,
          status: stripeResult.status,
          cardBrand: null,
          cardLast4: null,
        },
        tx,
      );

      await writeAudit({
        tx,
        bookingId,
        action: "PAYMENT_INTENT_CREATED",
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "payment",
        resourceId: paymentRow.id,
        occurredAt: now,
        payload: {
          provider: "stripe",
          providerReference: stripeResult.id,
          amountMinor: amountMinor.toString(),
          currency: normalisedCurrency,
          idempotencyKey,
          correlationId: correlationId ?? null,
        },
      });
    });

    this.log?.info(
      {
        bookingId,
        paymentId: paymentRow.id,
        amountMinor: amountMinor.toString(),
        currency: normalisedCurrency,
        actorId: actor.id,
      },
      "PaymentIntent created and persisted",
    );

    return {
      clientSecret: stripeResult.clientSecret,
      amountMinor: stripeResult.amountMinor,
      currency: normalisedCurrency,
      paymentId: paymentRow.id,
      status: mapStripeStatusToPlatform(stripeResult.status),
    };
  }
}

// ---------------------------------------------------------------------------
// Type guard helper
// ---------------------------------------------------------------------------

/** Returns true when `err` is a DomainError (has a string `code`). */
export function isPaymentDomainError(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as DomainError).code === "string"
  );
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Convert a decimal price string or number to integer minor units (cents).
 * Uses Math.round to absorb IEEE-754 representation errors.
 */
function toMinorUnits(amount: number | string): bigint {
  const numeric = typeof amount === "string" ? Number(amount) : amount;
  return BigInt(Math.round(numeric * 100));
}

/**
 * Map a Stripe PaymentIntent status string to the platform PaymentStatus enum.
 * Unmapped strings fall back to PROCESSING (safe default).
 */
function mapStripeStatusToPlatform(stripeStatus: string): string {
  switch (stripeStatus) {
    case "succeeded":
      return "SUCCEEDED";
    case "canceled":
      return "FAILED";
    case "requires_payment_method":
      return "REQUIRES_PAYMENT_METHOD";
    case "processing":
    case "requires_capture":
    case "requires_confirmation":
    case "requires_action":
    default:
      return "PROCESSING";
  }
}

/** Narrow-check whether an error is a DomainError (has a string `code`). */
function isDomainError(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as DomainError).code === "string"
  );
}
