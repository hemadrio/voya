/**
 * Unit tests for ReconciliationEngine (WO-050 AC10).
 *
 * The engine is pure: no infrastructure, no Prisma, no Stripe SDK.
 * Every exception kind is covered, plus the clean (no-exception) scenario,
 * amount equality boundaries, and integer-only amount comparison (AC7).
 */

import { describe, it, expect } from "vitest";
import {
  runReconciliation,
  type ProviderTransaction,
  type LedgerRow,
  type BookingState,
} from "../../src/domain/ReconciliationEngine.js";

import {
  // Clean scenario
  CLEAN_PROVIDER_TRANSACTIONS,
  CLEAN_LEDGER_ROWS,
  CLEAN_BOOKING_STATES,

  // SETTLED_WITHOUT_CONFIRMATION
  SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS,
  SETTLED_WITHOUT_CONFIRMATION_LEDGER,
  SETTLED_WITHOUT_CONFIRMATION_BOOKINGS,

  // CONFIRMED_WITHOUT_SETTLEMENT
  CONFIRMED_WITHOUT_SETTLEMENT_TRANSACTIONS,
  CONFIRMED_WITHOUT_SETTLEMENT_LEDGER,
  CONFIRMED_WITHOUT_SETTLEMENT_BOOKINGS,

  // REFUND_WITHOUT_CANCELLATION
  REFUND_WITHOUT_CANCELLATION_TRANSACTIONS,
  REFUND_WITHOUT_CANCELLATION_LEDGER,
  REFUND_WITHOUT_CANCELLATION_BOOKINGS,

  // AMOUNT_MISMATCH
  AMOUNT_MISMATCH_TRANSACTIONS,
  AMOUNT_MISMATCH_LEDGER,
  AMOUNT_MISMATCH_BOOKINGS,

  // CURRENCY_MISMATCH
  CURRENCY_MISMATCH_TRANSACTIONS,
  CURRENCY_MISMATCH_LEDGER,
  CURRENCY_MISMATCH_BOOKINGS,

  // CONFIRMATION_AFTER_TERMINAL
  CONFIRMATION_AFTER_TERMINAL_TRANSACTIONS,
  CONFIRMATION_AFTER_TERMINAL_LEDGER,
  CONFIRMATION_AFTER_TERMINAL_BOOKINGS,

  // ORPHAN_LEDGER_ROW
  ORPHAN_LEDGER_ROW_TRANSACTIONS,
  ORPHAN_LEDGER_ROW_LEDGER,
  ORPHAN_LEDGER_ROW_BOOKINGS,

  // Cancelled with refund (clean)
  CANCELLED_WITH_REFUND_TRANSACTIONS,
  CANCELLED_WITH_REFUND_LEDGER,
  CANCELLED_WITH_REFUND_BOOKINGS,

  // All exceptions in one day
  ALL_EXCEPTIONS_TRANSACTIONS,
  ALL_EXCEPTIONS_LEDGER,
  ALL_EXCEPTIONS_BOOKINGS,

  SYNTH_BOOKING_CONFIRMED,
  SYNTH_BOOKING_PENDING,
  SYNTH_BOOKING_EXPIRED,
  SYNTH_BOOKING_PURGED,
} from "../fixtures/reconciliation-fixtures.js";

// ---------------------------------------------------------------------------
// Clean scenario — zero exceptions
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: clean scenario (AC10)", () => {
  it("returns zero exceptions for a fully matched confirmed booking", () => {
    const result = runReconciliation(
      CLEAN_PROVIDER_TRANSACTIONS,
      CLEAN_LEDGER_ROWS,
      CLEAN_BOOKING_STATES,
    );
    expect(result.exceptions).toHaveLength(0);
  });

  it("returns zero exceptions for empty inputs (zero transactions day)", () => {
    const result = runReconciliation([], [], []);
    expect(result.exceptions).toHaveLength(0);
    expect(result.chargesCompared).toBe(0);
    expect(result.refundsCompared).toBe(0);
  });

  it("returns zero exceptions when a cancelled booking has a matching refund", () => {
    const result = runReconciliation(
      CANCELLED_WITH_REFUND_TRANSACTIONS,
      CANCELLED_WITH_REFUND_LEDGER,
      CANCELLED_WITH_REFUND_BOOKINGS,
    );
    expect(result.exceptions).toHaveLength(0);
  });

  it("counts chargesCompared and refundsCompared correctly for clean input", () => {
    const result = runReconciliation(
      CLEAN_PROVIDER_TRANSACTIONS,
      CLEAN_LEDGER_ROWS,
      CLEAN_BOOKING_STATES,
    );
    expect(result.chargesCompared).toBe(1);
    expect(result.refundsCompared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SETTLED_WITHOUT_CONFIRMATION
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: SETTLED_WITHOUT_CONFIRMATION (AC2)", () => {
  it("raises SETTLED_WITHOUT_CONFIRMATION when charge settled but booking is PENDING", () => {
    const result = runReconciliation(
      SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS,
      SETTLED_WITHOUT_CONFIRMATION_LEDGER,
      SETTLED_WITHOUT_CONFIRMATION_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "SETTLED_WITHOUT_CONFIRMATION");
    expect(ex).toBeDefined();
    expect(ex!.bookingId).toBe(SYNTH_BOOKING_PENDING);
  });

  it("raises SETTLED_WITHOUT_CONFIRMATION when booking is missing from bookingStates", () => {
    const result = runReconciliation(
      SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS,
      SETTLED_WITHOUT_CONFIRMATION_LEDGER,
      [], // no booking states at all
    );
    const ex = result.exceptions.find((e) => e.kind === "SETTLED_WITHOUT_CONFIRMATION");
    expect(ex).toBeDefined();
    expect(ex!.detail.reason).toBe("booking_not_found");
  });
});

// ---------------------------------------------------------------------------
// CONFIRMED_WITHOUT_SETTLEMENT
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: CONFIRMED_WITHOUT_SETTLEMENT (AC2)", () => {
  it("raises CONFIRMED_WITHOUT_SETTLEMENT when no provider transaction for a CONFIRMED booking", () => {
    const result = runReconciliation(
      CONFIRMED_WITHOUT_SETTLEMENT_TRANSACTIONS,
      CONFIRMED_WITHOUT_SETTLEMENT_LEDGER,
      CONFIRMED_WITHOUT_SETTLEMENT_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "CONFIRMED_WITHOUT_SETTLEMENT");
    expect(ex).toBeDefined();
    expect(ex!.bookingId).toBe(SYNTH_BOOKING_CONFIRMED);
  });

  it("does NOT raise CONFIRMED_WITHOUT_SETTLEMENT for PENDING bookings with no settlement", () => {
    const result = runReconciliation(
      [],
      [],
      [{ id: SYNTH_BOOKING_PENDING, status: "PENDING" }],
    );
    expect(result.exceptions.filter((e) => e.kind === "CONFIRMED_WITHOUT_SETTLEMENT")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REFUND_WITHOUT_CANCELLATION
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: REFUND_WITHOUT_CANCELLATION (AC2)", () => {
  it("raises REFUND_WITHOUT_CANCELLATION when refund exists but booking is CONFIRMED", () => {
    const result = runReconciliation(
      REFUND_WITHOUT_CANCELLATION_TRANSACTIONS,
      REFUND_WITHOUT_CANCELLATION_LEDGER,
      REFUND_WITHOUT_CANCELLATION_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "REFUND_WITHOUT_CANCELLATION");
    expect(ex).toBeDefined();
    expect(ex!.bookingId).toBe(SYNTH_BOOKING_CONFIRMED);
  });

  it("does NOT raise REFUND_WITHOUT_CANCELLATION when booking is CANCELLED", () => {
    const result = runReconciliation(
      CANCELLED_WITH_REFUND_TRANSACTIONS,
      CANCELLED_WITH_REFUND_LEDGER,
      CANCELLED_WITH_REFUND_BOOKINGS,
    );
    expect(result.exceptions.filter((e) => e.kind === "REFUND_WITHOUT_CANCELLATION")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AMOUNT_MISMATCH
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: AMOUNT_MISMATCH (AC2, AC7)", () => {
  it("raises AMOUNT_MISMATCH when provider amount differs from ledger amount", () => {
    const result = runReconciliation(
      AMOUNT_MISMATCH_TRANSACTIONS,
      AMOUNT_MISMATCH_LEDGER,
      AMOUNT_MISMATCH_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "AMOUNT_MISMATCH");
    expect(ex).toBeDefined();
    expect(ex!.expectedAmountMinor).toBe(49999n);
    expect(ex!.actualAmountMinor).toBe(49998n);
  });

  it("does NOT raise AMOUNT_MISMATCH when amounts are exactly equal (bigint equality, AC7)", () => {
    const result = runReconciliation(
      CLEAN_PROVIDER_TRANSACTIONS,
      CLEAN_LEDGER_ROWS,
      CLEAN_BOOKING_STATES,
    );
    expect(result.exceptions.filter((e) => e.kind === "AMOUNT_MISMATCH")).toHaveLength(0);
  });

  it("raises AMOUNT_MISMATCH for a difference of exactly 1 minor unit (AC7: no float rounding)", () => {
    const tx: ProviderTransaction[] = [{
      id: "bt_test_1",
      sourceId: "ch_test_1",
      type: "charge",
      amountMinor: 100n,
      currency: "usd",
      bookingId: SYNTH_BOOKING_CONFIRMED,
      paymentIntentId: "pi_test_1",
      settledAt: 1754006400,
    }];
    const ledger: LedgerRow[] = [{
      id: "led_test_1",
      bookingId: SYNTH_BOOKING_CONFIRMED,
      type: "CHARGE",
      providerReference: "pi_test_1",
      amountMinor: 101n, // 1 cent more
      currency: "usd",
      status: "SUCCEEDED",
    }];
    const result = runReconciliation(tx, ledger, [{ id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" }]);
    expect(result.exceptions.filter((e) => e.kind === "AMOUNT_MISMATCH")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CURRENCY_MISMATCH
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: CURRENCY_MISMATCH (AC2)", () => {
  it("raises CURRENCY_MISMATCH when provider currency differs from ledger currency", () => {
    const result = runReconciliation(
      CURRENCY_MISMATCH_TRANSACTIONS,
      CURRENCY_MISMATCH_LEDGER,
      CURRENCY_MISMATCH_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "CURRENCY_MISMATCH");
    expect(ex).toBeDefined();
    expect(ex!.detail.expectedCurrency).toBe("usd");
    expect(ex!.detail.actualCurrency).toBe("eur");
  });

  it("does NOT raise AMOUNT_MISMATCH when amounts equal but currencies differ (CURRENCY_MISMATCH takes priority)", () => {
    const result = runReconciliation(
      CURRENCY_MISMATCH_TRANSACTIONS,
      CURRENCY_MISMATCH_LEDGER,
      CURRENCY_MISMATCH_BOOKINGS,
    );
    expect(result.exceptions.filter((e) => e.kind === "AMOUNT_MISMATCH")).toHaveLength(0);
    expect(result.exceptions.filter((e) => e.kind === "CURRENCY_MISMATCH")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CONFIRMATION_AFTER_TERMINAL
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: CONFIRMATION_AFTER_TERMINAL (AC2)", () => {
  it("raises CONFIRMATION_AFTER_TERMINAL when charge settled for an EXPIRED booking", () => {
    const result = runReconciliation(
      CONFIRMATION_AFTER_TERMINAL_TRANSACTIONS,
      CONFIRMATION_AFTER_TERMINAL_LEDGER,
      CONFIRMATION_AFTER_TERMINAL_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "CONFIRMATION_AFTER_TERMINAL");
    expect(ex).toBeDefined();
    expect(ex!.bookingId).toBe(SYNTH_BOOKING_EXPIRED);
    expect(ex!.detail.bookingStatus).toBe("EXPIRED");
  });

  it("raises CONFIRMATION_AFTER_TERMINAL when charge settled for a CANCELLED booking", () => {
    const tx: ProviderTransaction[] = [{
      id: "bt_test_2",
      sourceId: "ch_test_2",
      type: "charge",
      amountMinor: 19999n,
      currency: "usd",
      bookingId: "f0000010-0000-4000-8000-000000000004",
      paymentIntentId: "pi_test_2",
      settledAt: 1754006400,
    }];
    const result = runReconciliation(tx, [], [
      { id: "f0000010-0000-4000-8000-000000000004", status: "CANCELLED" },
    ]);
    const ex = result.exceptions.find((e) => e.kind === "CONFIRMATION_AFTER_TERMINAL");
    expect(ex).toBeDefined();
    expect(ex!.detail.bookingStatus).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// ORPHAN_LEDGER_ROW
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: ORPHAN_LEDGER_ROW (AC2)", () => {
  it("raises ORPHAN_LEDGER_ROW when ledger CHARGE row has no provider transaction and no booking", () => {
    const result = runReconciliation(
      ORPHAN_LEDGER_ROW_TRANSACTIONS,
      ORPHAN_LEDGER_ROW_LEDGER,
      ORPHAN_LEDGER_ROW_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "ORPHAN_LEDGER_ROW");
    expect(ex).toBeDefined();
    expect(ex!.bookingId).toBe(SYNTH_BOOKING_PURGED);
  });

  it("does NOT raise ORPHAN_LEDGER_ROW when booking still exists (raises CONFIRMED_WITHOUT_SETTLEMENT instead)", () => {
    const result = runReconciliation(
      CONFIRMED_WITHOUT_SETTLEMENT_TRANSACTIONS,
      CONFIRMED_WITHOUT_SETTLEMENT_LEDGER,
      CONFIRMED_WITHOUT_SETTLEMENT_BOOKINGS,
    );
    expect(result.exceptions.filter((e) => e.kind === "ORPHAN_LEDGER_ROW")).toHaveLength(0);
    expect(result.exceptions.filter((e) => e.kind === "CONFIRMED_WITHOUT_SETTLEMENT")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-exception scenario — all kinds in one run
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: all exception kinds in one run", () => {
  it("detects at least one exception of each kind", () => {
    const result = runReconciliation(
      ALL_EXCEPTIONS_TRANSACTIONS,
      ALL_EXCEPTIONS_LEDGER,
      ALL_EXCEPTIONS_BOOKINGS,
    );

    const kinds = new Set(result.exceptions.map((e) => e.kind));
    expect(kinds.has("SETTLED_WITHOUT_CONFIRMATION")).toBe(true);
    expect(kinds.has("AMOUNT_MISMATCH")).toBe(true);
    expect(kinds.has("CURRENCY_MISMATCH")).toBe(true);
    expect(kinds.has("CONFIRMATION_AFTER_TERMINAL")).toBe(true);
    expect(kinds.has("REFUND_WITHOUT_CANCELLATION")).toBe(true);
    expect(kinds.has("ORPHAN_LEDGER_ROW")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Correct-terminal-state percentage (AC9)
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: correct-terminal-state metrics (AC9)", () => {
  it("reports confirmedWithSettlement = 1 when one confirmed booking has a matched charge", () => {
    const result = runReconciliation(
      CLEAN_PROVIDER_TRANSACTIONS,
      CLEAN_LEDGER_ROWS,
      CLEAN_BOOKING_STATES,
    );
    expect(result.confirmedWithSettlement).toBe(1);
    expect(result.totalSettledCharges).toBe(1);
  });

  it("reports confirmedWithSettlement = 0 for zero transactions", () => {
    const result = runReconciliation([], [], []);
    expect(result.confirmedWithSettlement).toBe(0);
    expect(result.totalSettledCharges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: exceptions carry required context fields
// ---------------------------------------------------------------------------

describe("ReconciliationEngine: exception context fields (AC3)", () => {
  it("AMOUNT_MISMATCH carries expectedAmountMinor, actualAmountMinor, and providerReference", () => {
    const result = runReconciliation(
      AMOUNT_MISMATCH_TRANSACTIONS,
      AMOUNT_MISMATCH_LEDGER,
      AMOUNT_MISMATCH_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "AMOUNT_MISMATCH")!;
    expect(ex.expectedAmountMinor).not.toBeNull();
    expect(ex.actualAmountMinor).not.toBeNull();
    expect(ex.providerReference).toBeTruthy();
  });

  it("SETTLED_WITHOUT_CONFIRMATION carries bookingId and paymentIntentId", () => {
    const result = runReconciliation(
      SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS,
      SETTLED_WITHOUT_CONFIRMATION_LEDGER,
      SETTLED_WITHOUT_CONFIRMATION_BOOKINGS,
    );
    const ex = result.exceptions.find((e) => e.kind === "SETTLED_WITHOUT_CONFIRMATION")!;
    expect(ex.bookingId).not.toBeNull();
    expect(ex.paymentIntentId).not.toBeNull();
  });

  it("detail must never contain card data or PII patterns", () => {
    const result = runReconciliation(
      ALL_EXCEPTIONS_TRANSACTIONS,
      ALL_EXCEPTIONS_LEDGER,
      ALL_EXCEPTIONS_BOOKINGS,
    );
    for (const ex of result.exceptions) {
      const detailStr = JSON.stringify(ex.detail);
      // No card-like patterns (16-digit numbers)
      expect(detailStr).not.toMatch(/\b\d{16}\b/);
      // No email addresses
      expect(detailStr).not.toMatch(/@/);
    }
  });
});
