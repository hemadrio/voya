/**
 * ReconciliationEngine — pure comparison engine (WO-050).
 *
 * Takes provider-settled transactions, ledger rows, and booking state
 * projections; returns a list of typed exceptions without touching any
 * infrastructure (no Prisma, no Stripe SDK, no HTTP, no filesystem).
 *
 * Amount comparisons use integer minor units throughout — no float arithmetic.
 *
 * Exception kinds (AC2):
 *   SETTLED_WITHOUT_CONFIRMATION  — Stripe settled charge, booking not CONFIRMED
 *   CONFIRMED_WITHOUT_SETTLEMENT  — booking CONFIRMED, no matching settled charge
 *   REFUND_WITHOUT_CANCELLATION   — Stripe refund, booking not CANCELLED
 *   AMOUNT_MISMATCH               — settlement amount ≠ ledger amount
 *   CURRENCY_MISMATCH             — settlement currency ≠ ledger currency
 *   CONFIRMATION_AFTER_TERMINAL   — WO-043 / WO-047 race handled here too
 *   ORPHAN_LEDGER_ROW             — ledger row has no matching Stripe transaction
 *                                   AND no live booking
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** A settled Stripe balance transaction (charge or refund). */
export interface ProviderTransaction {
  /** Stripe BalanceTransaction ID (bt_...) */
  id: string;
  /** Stripe Charge ID (ch_...) or Refund ID (re_...) */
  sourceId: string;
  /** "charge" | "refund" | "payment" | "payment_refund" — mapped from Stripe type */
  type: "charge" | "refund";
  /** Settlement amount in integer minor units (always positive) */
  amountMinor: bigint;
  /** ISO 4217 lower-case currency code */
  currency: string;
  /** Internal booking ID from payment metadata (may be null for non-platform charges) */
  bookingId: string | null;
  /** Stripe PaymentIntent ID (may be null for legacy charge objects) */
  paymentIntentId: string | null;
  /** Unix epoch seconds of settlement (used for UTC period attribution) */
  settledAt: number;
}

/** A row from the payments ledger (type=CHARGE or type=REFUND). */
export interface LedgerRow {
  /** Platform payment UUID */
  id: string;
  bookingId: string;
  /** "CHARGE" | "REFUND" */
  type: "CHARGE" | "REFUND";
  /** Stripe PaymentIntent ID or Charge ID */
  providerReference: string;
  /** Ledger amount in integer minor units */
  amountMinor: bigint;
  /** ISO 4217 lower-case currency code */
  currency: string;
  /** "SUCCEEDED" | "FAILED" | "REFUNDED" | "PENDING" */
  status: string;
}

/** Minimal booking state projection needed by the engine. */
export interface BookingState {
  id: string;
  /** "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED" */
  status: string;
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export type ExceptionKind =
  | "SETTLED_WITHOUT_CONFIRMATION"
  | "CONFIRMED_WITHOUT_SETTLEMENT"
  | "REFUND_WITHOUT_CANCELLATION"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "CONFIRMATION_AFTER_TERMINAL"
  | "ORPHAN_LEDGER_ROW";

export interface DetectedReconciliationException {
  kind: ExceptionKind;
  bookingId: string | null;
  paymentIntentId: string | null;
  providerReference: string | null;
  expectedAmountMinor: bigint | null;
  actualAmountMinor: bigint | null;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReconciliationEngineResult {
  exceptions: DetectedReconciliationException[];
  /** Total provider charge transactions processed */
  chargesCompared: number;
  /** Total provider refund transactions processed */
  refundsCompared: number;
  /** Count of CONFIRMED bookings that have a matching settled charge */
  confirmedWithSettlement: number;
  /** Total settled charges processed (charges only, not refunds) */
  totalSettledCharges: number;
}

/**
 * Run the reconciliation comparison.
 *
 * All parameters are immutable value objects. No side effects.
 */
export function runReconciliation(
  providerTransactions: readonly ProviderTransaction[],
  ledgerRows: readonly LedgerRow[],
  bookingStates: readonly BookingState[],
): ReconciliationEngineResult {
  const exceptions: DetectedReconciliationException[] = [];

  // Build lookup maps for O(1) access
  const ledgerByRef = new Map<string, LedgerRow>();
  for (const row of ledgerRows) {
    ledgerByRef.set(row.providerReference, row);
  }

  const bookingById = new Map<string, BookingState>();
  for (const b of bookingStates) {
    bookingById.set(b.id, b);
  }

  // Track which booking IDs have a matched settled charge on provider side
  const settledBookingIds = new Set<string>();
  // Track which ledger providerReferences were matched by provider data
  const matchedLedgerRefs = new Set<string>();

  let chargesCompared = 0;
  let refundsCompared = 0;

  // ── Pass 1: iterate provider transactions ──────────────────────────────

  for (const tx of providerTransactions) {
    if (tx.type === "charge") {
      chargesCompared++;

      if (tx.bookingId !== null) {
        settledBookingIds.add(tx.bookingId);
      }

      // Find matching ledger row
      const ledger = tx.paymentIntentId
        ? ledgerByRef.get(tx.paymentIntentId)
        : tx.sourceId
          ? ledgerByRef.get(tx.sourceId)
          : undefined;

      if (ledger) {
        matchedLedgerRefs.add(ledger.providerReference);

        // Currency check — before amount (different currency makes amount meaningless)
        if (ledger.currency !== tx.currency) {
          exceptions.push({
            kind: "CURRENCY_MISMATCH",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: ledger.amountMinor,
            actualAmountMinor: tx.amountMinor,
            detail: {
              expectedCurrency: ledger.currency,
              actualCurrency: tx.currency,
              ledgerPaymentId: ledger.id,
            },
          });
          continue;
        }

        // Amount check — integer comparison only (AC7)
        if (ledger.amountMinor !== tx.amountMinor) {
          exceptions.push({
            kind: "AMOUNT_MISMATCH",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: ledger.amountMinor,
            actualAmountMinor: tx.amountMinor,
            detail: {
              currency: tx.currency,
              ledgerPaymentId: ledger.id,
            },
          });
          continue;
        }
      }

      // Check booking confirmation state
      if (tx.bookingId !== null) {
        const booking = bookingById.get(tx.bookingId);

        if (!booking) {
          // Booking not found — orphan or purged. Treated as SETTLED_WITHOUT_CONFIRMATION.
          exceptions.push({
            kind: "SETTLED_WITHOUT_CONFIRMATION",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: null,
            actualAmountMinor: tx.amountMinor,
            detail: {
              currency: tx.currency,
              reason: "booking_not_found",
            },
          });
          continue;
        }

        if (booking.status === "EXPIRED" || booking.status === "CANCELLED") {
          exceptions.push({
            kind: "CONFIRMATION_AFTER_TERMINAL",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: null,
            actualAmountMinor: tx.amountMinor,
            detail: {
              bookingStatus: booking.status,
              currency: tx.currency,
            },
          });
          continue;
        }

        if (booking.status !== "CONFIRMED") {
          exceptions.push({
            kind: "SETTLED_WITHOUT_CONFIRMATION",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: null,
            actualAmountMinor: tx.amountMinor,
            detail: {
              bookingStatus: booking.status,
              currency: tx.currency,
            },
          });
        }
      }
    } else if (tx.type === "refund") {
      refundsCompared++;

      if (tx.bookingId !== null) {
        const booking = bookingById.get(tx.bookingId);
        if (booking && booking.status !== "CANCELLED") {
          // Stripe issued a refund but booking is not CANCELLED — anomaly
          exceptions.push({
            kind: "REFUND_WITHOUT_CANCELLATION",
            bookingId: tx.bookingId,
            paymentIntentId: tx.paymentIntentId,
            providerReference: tx.sourceId,
            expectedAmountMinor: null,
            actualAmountMinor: tx.amountMinor,
            detail: {
              bookingStatus: booking.status,
              currency: tx.currency,
            },
          });
        }
      }
    }
  }

  // ── Pass 2: confirmed bookings without settlement ─────────────────────

  for (const booking of bookingStates) {
    if (booking.status === "CONFIRMED" && !settledBookingIds.has(booking.id)) {
      // Find the ledger CHARGE row for this booking
      const chargeRow = ledgerRows.find(
        (r) => r.bookingId === booking.id && r.type === "CHARGE" && r.status === "SUCCEEDED",
      );

      exceptions.push({
        kind: "CONFIRMED_WITHOUT_SETTLEMENT",
        bookingId: booking.id,
        paymentIntentId: chargeRow?.providerReference ?? null,
        providerReference: chargeRow?.providerReference ?? null,
        expectedAmountMinor: chargeRow?.amountMinor ?? null,
        actualAmountMinor: null,
        detail: {
          ledgerPaymentId: chargeRow?.id ?? null,
        },
      });
    }
  }

  // ── Pass 3: orphan ledger rows ────────────────────────────────────────

  for (const row of ledgerRows) {
    if (row.type === "CHARGE" && !matchedLedgerRefs.has(row.providerReference)) {
      const booking = bookingById.get(row.bookingId);
      // Only an ORPHAN if there is ALSO no booking (booking deleted / purged).
      // If the booking exists but has no provider transaction, that is
      // CONFIRMED_WITHOUT_SETTLEMENT (already handled above).
      if (!booking) {
        exceptions.push({
          kind: "ORPHAN_LEDGER_ROW",
          bookingId: row.bookingId,
          paymentIntentId: row.providerReference,
          providerReference: row.providerReference,
          expectedAmountMinor: row.amountMinor,
          actualAmountMinor: null,
          detail: {
            ledgerPaymentId: row.id,
            currency: row.currency,
            ledgerStatus: row.status,
          },
        });
      }
    }
  }

  // ── Metrics helper values ─────────────────────────────────────────────

  const confirmedWithSettlement = Array.from(settledBookingIds).filter(
    (id) => bookingById.get(id)?.status === "CONFIRMED",
  ).length;

  return {
    exceptions,
    chargesCompared,
    refundsCompared,
    confirmedWithSettlement,
    totalSettledCharges: chargesCompared,
  };
}
