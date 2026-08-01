/**
 * PriceRevalidationService — mandatory price re-check before payment (WO-042).
 *
 * Contract:
 *   revalidate(bookingId, actor, correlationId?) → RevalidateResult
 *   acceptPrice(bookingId, acceptedTotal, currency, actor, correlationId?) → AcceptResult
 *
 * Guarantees:
 *   1. Every booking leg is re-priced against the live supplier within 1,500 ms.
 *      Each leg call is wrapped in an independent AbortController so one slow
 *      supplier cannot exhaust the entire budget.
 *   2. When ANY leg fails (timeout, supplier error, rejection), the whole
 *      revalidation fails with the appropriate domain error.
 *   3. When the total is unchanged, the booking is marked payable immediately
 *      (no consent step needed).
 *   4. When the total changed, the booking is NOT marked payable; the traveler
 *      must call acceptPrice with the exact new total.
 *   5. acceptPrice verifies the submitted total exactly matches the quoted total
 *      (string comparison of toFixed(2)) and that the quote has not expired.
 *   6. A PRICE_ACCEPTED audit row is written atomically with the consent record.
 *   7. Payment may never be initiated on a booking whose payableUntil is null or
 *      in the past — asserted via assertPayable().
 *
 * No Prisma, no Express — all dependencies injected.
 */

import {
  priceConsentRequired,
  quoteExpired,
  notFound,
  supplierTimeout,
  supplierUnavailable,
  supplierRejected,
} from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";
import type { AuditTxClient } from "./AuditWriter.js";
import { writeAudit } from "./AuditWriter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for each individual supplier leg re-price call (ms). */
export const SUPPLIER_TIMEOUT_MS = 1_500;

/** How long the payment window stays open after a successful re-validation. */
export const QUOTE_VALIDITY_MS = 15 * 60 * 1_000; // 15 minutes

// ---------------------------------------------------------------------------
// Supplier adapter port
// ---------------------------------------------------------------------------

/** Outcome of a single supplier leg re-price call. */
export interface RepriceOutcome {
  offerId: string;
  supplier: string;
  /** Re-validated price as a positive number with at most 2 decimal places. */
  price: number;
  currency: string;
  /** How fresh this price is — LIVE = fetched now, CACHED = within window, STALE = past window. */
  freshness: "LIVE" | "CACHED" | "STALE";
}

/**
 * Port for issuing per-leg supplier re-price calls.
 *
 * Implementations MUST honour the AbortSignal passed with each call so
 * the 1,500 ms budget is enforced end-to-end, including network time.
 * When the signal fires the implementation must throw (or reject) so the
 * Promise.allSettled loop can map it to a SUPPLIER_TIMEOUT error.
 */
export interface SupplierRepricePort {
  repriceOffer(
    offerId: string,
    supplier: string,
    signal: AbortSignal,
  ): Promise<RepriceOutcome>;
}

// ---------------------------------------------------------------------------
// Repository port
// ---------------------------------------------------------------------------

/** Minimal booking row needed for price re-validation. */
export interface RevalidationBookingRow {
  id: string;
  status: string;
  /** Decimal string — original snapshot total. */
  totalPrice: string;
  currency: string;
  /** Parsed offer snapshot as stored. */
  offerSnapshot: Record<string, unknown>;
  /** Previously stored re-validated snapshot (null if not yet revalidated). */
  revalidatedSnapshot: Record<string, unknown> | null;
  /** Current payment deadline (null if booking is not yet payable). */
  payableUntil: Date | null;
}

/**
 * Consent record written to booking_price_consents.
 */
export interface ConsentRecord {
  bookingId: string;
  previousTotal: string;
  acceptedTotal: string;
  currency: string;
  actorId: string;
  acceptedAt: Date;
  correlationId: string | null;
}

/**
 * Repository operations required by PriceRevalidationService.
 *
 * Concrete implementation: BookingRepository.
 * Test doubles: plain objects satisfying this interface.
 */
export interface RevalidationRepositoryPort {
  /** Find a booking by ID for revalidation purposes (no ownership predicate). */
  findBookingForRevalidation(bookingId: string): Promise<RevalidationBookingRow | null>;

  /**
   * Persist the re-validated snapshot and set payableUntil on the booking.
   * Called when re-validation finds no price change (marking the booking
   * immediately payable) or when accepting a changed price.
   */
  saveRevalidationResult(
    bookingId: string,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
  ): Promise<void>;

  /**
   * Persist a consent record and update payableUntil in one transaction.
   * Also writes the PRICE_ACCEPTED audit row through the tx client.
   */
  saveConsentAndMarkPayable(
    consent: ConsentRecord,
    revalidatedSnapshot: Record<string, unknown>,
    payableUntil: Date,
    tx: AuditTxClient,
  ): Promise<void>;

  /** Wrap work in a transaction. */
  runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RevalidatedLegResult {
  offerId: string;
  supplier: string;
  price: number;
  currency: string;
  freshness: "LIVE" | "CACHED" | "STALE";
}

export interface RevalidateResult {
  bookingId: string;
  priceChanged: boolean;
  previousTotal: number;
  newTotal: number;
  currency: string;
  delta: number;
  quoteExpiresAt: Date;
  legs: RevalidatedLegResult[];
}

export interface AcceptResult {
  payableUntil: Date;
}

// ---------------------------------------------------------------------------
// Actor context
// ---------------------------------------------------------------------------

export interface RevalidationActor {
  id: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface RevalidationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface RevalidationDeps {
  supplierPort: SupplierRepricePort;
  repository: RevalidationRepositoryPort;
  clock?: () => Date;
  log?: RevalidationLogger;
  /** Override timeout per supplier call — useful for tests. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// PriceRevalidationService
// ---------------------------------------------------------------------------

export class PriceRevalidationService {
  private readonly supplierPort: SupplierRepricePort;
  private readonly repo: RevalidationRepositoryPort;
  private readonly clock: () => Date;
  private readonly log: RevalidationLogger | undefined;
  private readonly timeoutMs: number;

  constructor(deps: RevalidationDeps) {
    this.supplierPort = deps.supplierPort;
    this.repo = deps.repository;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
    this.timeoutMs = deps.timeoutMs ?? SUPPLIER_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // revalidate
  // -------------------------------------------------------------------------

  /**
   * Re-price every leg of the booking through the supplier adapter port.
   *
   * Fan-out is parallel — one AbortController per leg, each with a hard
   * `timeoutMs` cap so a single slow supplier cannot blow the checkout budget.
   *
   * On any failure (timeout, supplier error, rejection):
   *   - Timeout → SUPPLIER_TIMEOUT (504)
   *   - Supplier error → SUPPLIER_UNAVAILABLE (502)
   *   - Sold out / rejected → SUPPLIER_REJECTED (422)
   *   - Open breaker → SUPPLIER_UNAVAILABLE (502)
   *
   * On success:
   *   - priceChanged=false → booking marked payable immediately.
   *   - priceChanged=true  → revalidated snapshot stored; NOT marked payable.
   */
  async revalidate(
    bookingId: string,
    actor: RevalidationActor,
    correlationId?: string,
  ): Promise<RevalidateResult> {
    const booking = await this.repo.findBookingForRevalidation(bookingId);
    if (!booking) {
      throw notFound(`Booking "${bookingId}" not found.`);
    }

    const snapshot = booking.offerSnapshot;
    const legs = extractLegs(snapshot);
    const previousTotal = Number(booking.totalPrice);
    const currency = booking.currency;

    // Fan out to all legs in parallel with individual per-leg timeouts.
    const results = await this.repriceLegsParallel(legs);

    // Inspect settled results — any rejection fails the whole revalidation.
    const legOutcomes = this.collectOrThrow(results);

    // Compute aggregate total across legs.
    const newTotal = legOutcomes.reduce((sum, leg) => sum + leg.price, 0);
    const newTotalRounded = round2(newTotal);
    const previousTotalRounded = round2(previousTotal);
    const delta = round2(newTotalRounded - previousTotalRounded);
    const priceChanged = newTotalRounded.toFixed(2) !== previousTotalRounded.toFixed(2);

    const now = this.clock();
    const quoteExpiresAt = new Date(now.getTime() + QUOTE_VALIDITY_MS);

    // Build revalidated snapshot to persist.
    const revalidatedSnapshot = buildRevalidatedSnapshot(
      snapshot,
      newTotalRounded,
      currency,
      legOutcomes,
    );

    if (!priceChanged) {
      // Mark payable immediately — no consent step needed.
      await this.repo.saveRevalidationResult(bookingId, revalidatedSnapshot, quoteExpiresAt);
      this.log?.info(
        { bookingId, previousTotal, newTotal: newTotalRounded, actorId: actor.id },
        "Price re-validation: no change — booking marked payable",
      );
    } else {
      // Store snapshot for consent step — NOT yet payable.
      await this.repo.saveRevalidationResult(bookingId, revalidatedSnapshot, new Date(0));
      this.log?.warn(
        { bookingId, previousTotal, newTotal: newTotalRounded, delta, actorId: actor.id },
        "Price re-validation: price changed — consent required",
      );
    }

    return {
      bookingId,
      priceChanged,
      previousTotal: previousTotalRounded,
      newTotal: newTotalRounded,
      currency,
      delta,
      quoteExpiresAt,
      legs: legOutcomes,
    };
  }

  // -------------------------------------------------------------------------
  // acceptPrice
  // -------------------------------------------------------------------------

  /**
   * Record the traveler's explicit consent to a changed price.
   *
   * Verifies:
   *   1. Booking exists and has been revalidated.
   *   2. The quote has not expired.
   *   3. The submitted total exactly matches the revalidated total (toFixed(2)).
   *   4. Currency matches.
   *
   * Writes atomically:
   *   - booking_price_consents row
   *   - bookings.payable_until = now + QUOTE_VALIDITY_MS
   *   - PRICE_ACCEPTED audit row
   */
  async acceptPrice(
    bookingId: string,
    acceptedTotal: number,
    currency: string,
    actor: RevalidationActor,
    correlationId?: string,
  ): Promise<AcceptResult> {
    const booking = await this.repo.findBookingForRevalidation(bookingId);
    if (!booking) {
      throw notFound(`Booking "${bookingId}" not found.`);
    }

    const revalidatedSnapshot = booking.revalidatedSnapshot;
    if (!revalidatedSnapshot) {
      throw priceConsentRequired(
        `Booking "${bookingId}" has not been re-validated. ` +
          `Please call revalidate before accepting a price.`,
      );
    }

    // Check quote expiry.
    const now = this.clock();
    const revalidatedAt = extractRevalidatedAt(revalidatedSnapshot);
    if (revalidatedAt !== null && revalidatedAt.getTime() + QUOTE_VALIDITY_MS < now.getTime()) {
      throw quoteExpired(
        `The price quote for booking "${bookingId}" has expired. ` +
          `Please re-validate the booking to obtain a fresh quote.`,
      );
    }

    // Extract the re-validated total for comparison.
    const quotedTotal = extractRevalidatedTotal(revalidatedSnapshot);
    const quotedCurrency = extractRevalidatedCurrency(revalidatedSnapshot) ?? booking.currency;

    // Exact currency match.
    if (currency.toUpperCase() !== quotedCurrency.toUpperCase()) {
      throw priceConsentRequired(
        `Currency mismatch: submitted "${currency}" but the quoted currency is "${quotedCurrency}".`,
      );
    }

    // Exact total match (toFixed(2) string comparison — never epsilon-based).
    if (round2(acceptedTotal).toFixed(2) !== round2(quotedTotal).toFixed(2)) {
      throw priceConsentRequired(
        `Accepted total ${acceptedTotal.toFixed(2)} does not match the quoted total ` +
          `${quotedTotal.toFixed(2)} ${quotedCurrency}. ` +
          `The submitted total must exactly equal the value returned by the revalidate endpoint.`,
      );
    }

    const payableUntil = new Date(now.getTime() + QUOTE_VALIDITY_MS);

    const consent: ConsentRecord = {
      bookingId,
      previousTotal: Number(booking.totalPrice).toFixed(2),
      acceptedTotal: round2(acceptedTotal).toFixed(2),
      currency: quotedCurrency.toUpperCase(),
      actorId: actor.id,
      acceptedAt: now,
      correlationId: correlationId ?? null,
    };

    await this.repo.runInTransaction(async (tx) => {
      await this.repo.saveConsentAndMarkPayable(consent, revalidatedSnapshot, payableUntil, tx);

      await writeAudit({
        tx,
        bookingId,
        action: "PRICE_ACCEPTED",
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "booking",
        resourceId: bookingId,
        occurredAt: now,
        payload: {
          previousTotal: consent.previousTotal,
          acceptedTotal: consent.acceptedTotal,
          currency: consent.currency,
          payableUntil: payableUntil.toISOString(),
          correlationId: correlationId ?? null,
        },
      });
    });

    this.log?.info(
      { bookingId, acceptedTotal, currency: quotedCurrency, actorId: actor.id, payableUntil },
      "Price consent recorded — booking marked payable",
    );

    return { payableUntil };
  }

  // -------------------------------------------------------------------------
  // assertPayable — hard precondition gate for payment intent creation (AC4)
  // -------------------------------------------------------------------------

  /**
   * Throws PRICE_CONSENT_REQUIRED (409) when the booking is not in a payable
   * state. Call this before initiating any Stripe PaymentIntent.
   *
   * A booking is payable when:
   *   - payableUntil is not null, AND
   *   - payableUntil is strictly in the future relative to `now`.
   */
  async assertPayable(bookingId: string): Promise<void> {
    const booking = await this.repo.findBookingForRevalidation(bookingId);
    if (!booking) {
      throw notFound(`Booking "${bookingId}" not found.`);
    }
    if (!booking.payableUntil || booking.payableUntil <= this.clock()) {
      throw priceConsentRequired(
        `Booking "${bookingId}" has not passed price re-validation or the payment window has expired. ` +
          `Please call POST /v1/bookings/${bookingId}/revalidate before initiating payment.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async repriceLegsParallel(
    legs: Array<{ offerId: string; supplier: string }>,
  ): Promise<PromiseSettledResult<RepriceOutcome>[]> {
    return Promise.allSettled(
      legs.map((leg) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        return this.supplierPort
          .repriceOffer(leg.offerId, leg.supplier, controller.signal)
          .finally(() => clearTimeout(timer));
      }),
    );
  }

  private collectOrThrow(
    results: PromiseSettledResult<RepriceOutcome>[],
  ): RepriceOutcome[] {
    const outcomes: RepriceOutcome[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        outcomes.push(result.value);
      } else {
        // Map the rejection reason to a domain error.
        throw mapSupplierError(result.reason);
      }
    }
    return outcomes;
  }
}

// ---------------------------------------------------------------------------
// Type-guard helper for payment layer
// ---------------------------------------------------------------------------

/**
 * Returns true when `err` is a DomainError with code PRICE_CONSENT_REQUIRED.
 */
export function isPriceConsentRequired(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as DomainError).code === "PRICE_CONSENT_REQUIRED"
  );
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Round a number to 2 decimal places (no floating-point arithmetic tricks). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Extract per-leg descriptors from an offer snapshot. */
function extractLegs(
  snapshot: Record<string, unknown>,
): Array<{ offerId: string; supplier: string }> {
  const raw = snapshot["legs"];
  if (!Array.isArray(raw) || raw.length === 0) {
    // Single-leg booking: treat the snapshot itself as the only leg.
    return [
      {
        offerId: String(snapshot["offerId"] ?? ""),
        supplier: String(snapshot["supplier"] ?? ""),
      },
    ];
  }
  return raw.map((leg: unknown) => {
    const l = leg as Record<string, unknown>;
    return {
      offerId: String(l["offerId"] ?? ""),
      supplier: String(l["supplier"] ?? ""),
    };
  });
}

/** Build the revalidated snapshot from the original + new prices. */
function buildRevalidatedSnapshot(
  original: Record<string, unknown>,
  newTotal: number,
  currency: string,
  legs: RepriceOutcome[],
): Record<string, unknown> {
  return {
    ...original,
    totalPrice: newTotal.toFixed(2),
    currency: currency.toUpperCase(),
    revalidatedAt: new Date().toISOString(),
    legs: legs.map((l) => ({
      offerId: l.offerId,
      supplier: l.supplier,
      price: l.price.toFixed(2),
      currency: l.currency,
      freshness: l.freshness,
    })),
  };
}

function extractRevalidatedTotal(snapshot: Record<string, unknown>): number {
  const raw = snapshot["totalPrice"];
  return typeof raw === "string" ? Number(raw) : Number(raw ?? 0);
}

function extractRevalidatedCurrency(
  snapshot: Record<string, unknown>,
): string | null {
  const raw = snapshot["currency"];
  return typeof raw === "string" ? raw : null;
}

function extractRevalidatedAt(snapshot: Record<string, unknown>): Date | null {
  const raw = snapshot["revalidatedAt"];
  if (typeof raw === "string") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Map a supplier call rejection to the appropriate domain error.
 * Signal abort → SUPPLIER_TIMEOUT (504).
 * Error with code already set → pass through.
 * Circuit breaker open → SUPPLIER_UNAVAILABLE (502).
 * Sold-out / rejection → SUPPLIER_REJECTED (422).
 * Anything else → SUPPLIER_UNAVAILABLE (502).
 */
function mapSupplierError(reason: unknown): DomainError {
  if (reason instanceof Error) {
    // AbortError from AbortController.abort()
    if (reason.name === "AbortError") {
      return supplierTimeout(
        `Supplier re-price call timed out after ${SUPPLIER_TIMEOUT_MS} ms. Please try again.`,
      );
    }
    // Already a DomainError — pass through.
    if (
      typeof (reason as DomainError).code === "string" &&
      ["SUPPLIER_REJECTED", "SUPPLIER_UNAVAILABLE", "SUPPLIER_TIMEOUT"].includes(
        (reason as DomainError).code,
      )
    ) {
      return reason as DomainError;
    }
    // Sold-out signal from supplier adapter.
    if (reason.message.includes("SOLD_OUT") || reason.message.includes("INVENTORY_UNAVAILABLE")) {
      return supplierRejected(reason.message);
    }
    // Open circuit breaker signal.
    if (reason.message.includes("CIRCUIT_OPEN") || reason.message.includes("circuit")) {
      return supplierUnavailable(
        `Supplier circuit breaker is open. The supplier may be degraded. Please try again later.`,
      );
    }
  }
  return supplierUnavailable(
    `Supplier returned an unexpected error during re-price. Please try again.`,
  );
}
