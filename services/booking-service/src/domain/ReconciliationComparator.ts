/**
 * ReconciliationComparator — pure functions for comparing Booking.passengers
 * array lengths against booking_travelers row counts.
 *
 * Called by scripts/reconcile-booking-travelers.ts and unit-tested
 * independently of any database or KMS dependency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookingCountRow {
  bookingId: string;
  /** Length of the legacy passengers JSON array (0 if null or empty). */
  passengersArrayLength: number;
  /** Count of booking_travelers rows for this booking. */
  travelersRowCount: number;
}

export interface ReconciliationMismatch {
  bookingId: string;
  passengersArrayLength: number;
  bookingTravelersCount: number;
  /** Positive = more travelers than passengers (duplicate). Negative = under-migrated. */
  delta: number;
}

export interface ReconciliationReport {
  totalBookings: number;
  totalMatched: number;
  mismatches: ReconciliationMismatch[];
  passed: boolean;
  ranAt: string;
}

// ---------------------------------------------------------------------------
// Pure comparison functions
// ---------------------------------------------------------------------------

/**
 * Compare per-booking passenger array length against booking_travelers count.
 * Returns only the mismatches — an empty array means the reconciliation passed.
 */
export function compareBookingCounts(rows: BookingCountRow[]): ReconciliationMismatch[] {
  const mismatches: ReconciliationMismatch[] = [];

  for (const row of rows) {
    if (row.passengersArrayLength !== row.travelersRowCount) {
      mismatches.push({
        bookingId: row.bookingId,
        passengersArrayLength: row.passengersArrayLength,
        bookingTravelersCount: row.travelersRowCount,
        delta: row.travelersRowCount - row.passengersArrayLength,
      });
    }
  }

  return mismatches;
}

/**
 * Build a full reconciliation report from a set of per-booking count rows.
 */
export function buildReconciliationReport(rows: BookingCountRow[]): ReconciliationReport {
  const mismatches = compareBookingCounts(rows);

  return {
    totalBookings: rows.length,
    totalMatched: rows.length - mismatches.length,
    mismatches,
    passed: mismatches.length === 0,
    ranAt: new Date().toISOString(),
  };
}
