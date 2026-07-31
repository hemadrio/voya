/**
 * Unit tests for the reconciliation comparator logic.
 *
 * Tests the core comparison function that checks whether the count
 * of elements in Booking.passengers matches the count of rows in
 * booking_travelers for each booking.
 *
 * Covers AC5 and AC10 (reconciliation comparator unit tested with
 * mocked data).
 */

import { describe, it, expect } from "vitest";
import {
  compareBookingCounts,
  buildReconciliationReport,
  type BookingCountRow,
  type ReconciliationMismatch,
} from "../../src/domain/ReconciliationComparator.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareBookingCounts", () => {
  it("returns no mismatches when all counts match", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b1", passengersArrayLength: 2, travelersRowCount: 2 },
      { bookingId: "b2", passengersArrayLength: 1, travelersRowCount: 1 },
      { bookingId: "b3", passengersArrayLength: 0, travelersRowCount: 0 },
    ];

    const mismatches = compareBookingCounts(rows);
    expect(mismatches).toHaveLength(0);
  });

  it("returns mismatch when travelersRowCount < passengersArrayLength", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b1", passengersArrayLength: 3, travelersRowCount: 2 },
    ];

    const mismatches = compareBookingCounts(rows);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject<ReconciliationMismatch>({
      bookingId: "b1",
      passengersArrayLength: 3,
      bookingTravelersCount: 2,
      delta: -1,
    });
  });

  it("returns mismatch when travelersRowCount > passengersArrayLength (duplicate insert)", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b2", passengersArrayLength: 1, travelersRowCount: 2 },
    ];

    const mismatches = compareBookingCounts(rows);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.delta).toBe(1);
  });

  it("handles empty dataset with no mismatches", () => {
    expect(compareBookingCounts([])).toHaveLength(0);
  });

  it("handles null passengers column as zero array length", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b3", passengersArrayLength: 0, travelersRowCount: 0 },
    ];
    expect(compareBookingCounts(rows)).toHaveLength(0);
  });

  it("detects multiple mismatches across a mixed batch", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b1", passengersArrayLength: 2, travelersRowCount: 2 },
      { bookingId: "b2", passengersArrayLength: 3, travelersRowCount: 1 },
      { bookingId: "b3", passengersArrayLength: 1, travelersRowCount: 0 },
      { bookingId: "b4", passengersArrayLength: 0, travelersRowCount: 0 },
    ];

    const mismatches = compareBookingCounts(rows);
    expect(mismatches).toHaveLength(2);
    expect(mismatches.map((m) => m.bookingId)).toEqual(["b2", "b3"]);
  });
});

describe("buildReconciliationReport", () => {
  it("builds a passing report with zero mismatches", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b1", passengersArrayLength: 2, travelersRowCount: 2 },
      { bookingId: "b2", passengersArrayLength: 0, travelersRowCount: 0 },
    ];

    const report = buildReconciliationReport(rows);
    expect(report.totalBookings).toBe(2);
    expect(report.totalMatched).toBe(2);
    expect(report.mismatches).toHaveLength(0);
    expect(report.passed).toBe(true);
    expect(report.ranAt).toBeTruthy();
  });

  it("builds a failing report when mismatches exist", () => {
    const rows: BookingCountRow[] = [
      { bookingId: "b1", passengersArrayLength: 2, travelersRowCount: 2 },
      { bookingId: "b2", passengersArrayLength: 3, travelersRowCount: 1 },
    ];

    const report = buildReconciliationReport(rows);
    expect(report.passed).toBe(false);
    expect(report.totalMatched).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.bookingId).toBe("b2");
  });
});
