import { describe, it, expect } from "vitest";
import {
  computeNights,
  isRangeAvailable,
  validateMinimumStay,
  validateCheckInDay,
  findNearestAvailableRange,
} from "../../../lib/booking/availability.js";
import type { AvailabilityResponse } from "../../../lib/api/listings.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPEN_AVAIL: AvailabilityResponse = {
  blockedRanges: [],
  minimumStayByDate: {},
  checkInAllowedDays: [0, 1, 2, 3, 4, 5, 6],
};

const BLOCKED_AVAIL: AvailabilityResponse = {
  blockedRanges: [
    { start: "2026-08-10", end: "2026-08-20", reason: "booked" },
    { start: "2026-08-25", end: "2026-08-28", reason: "blocked" },
  ],
  minimumStayByDate: {
    "2026-08-21": 3,
  },
  checkInAllowedDays: [0, 1, 2, 3, 4, 5, 6],
};

const MON_ONLY_AVAIL: AvailabilityResponse = {
  blockedRanges: [],
  minimumStayByDate: {},
  checkInAllowedDays: [1], // Monday only
};

// ---------------------------------------------------------------------------
// computeNights
// ---------------------------------------------------------------------------

describe("computeNights", () => {
  it("returns 1 for consecutive dates", () => {
    expect(computeNights("2026-08-01", "2026-08-02")).toBe(1);
  });

  it("returns 7 for a week", () => {
    expect(computeNights("2026-08-01", "2026-08-08")).toBe(7);
  });

  it("returns 0 for same date", () => {
    expect(computeNights("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("handles month boundaries", () => {
    expect(computeNights("2026-07-30", "2026-08-03")).toBe(4);
  });

  it("handles year boundaries", () => {
    expect(computeNights("2025-12-29", "2026-01-02")).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// isRangeAvailable
// ---------------------------------------------------------------------------

describe("isRangeAvailable", () => {
  it("returns true when no blocked ranges", () => {
    expect(isRangeAvailable("2026-08-01", "2026-08-05", OPEN_AVAIL)).toBe(true);
  });

  it("returns false when range overlaps a blocked period", () => {
    expect(isRangeAvailable("2026-08-08", "2026-08-12", BLOCKED_AVAIL)).toBe(false);
  });

  it("returns false when range is entirely inside a blocked period", () => {
    expect(isRangeAvailable("2026-08-12", "2026-08-15", BLOCKED_AVAIL)).toBe(false);
  });

  it("returns false when range spans a blocked period", () => {
    expect(isRangeAvailable("2026-08-05", "2026-08-22", BLOCKED_AVAIL)).toBe(false);
  });

  it("returns true when range ends exactly when blocked period starts", () => {
    // [checkIn, checkOut) = [2026-08-05, 2026-08-10) doesn't overlap [2026-08-10, 2026-08-20)
    expect(isRangeAvailable("2026-08-05", "2026-08-10", BLOCKED_AVAIL)).toBe(true);
  });

  it("returns true when range starts exactly when blocked period ends", () => {
    expect(isRangeAvailable("2026-08-20", "2026-08-23", BLOCKED_AVAIL)).toBe(true);
  });

  it("returns true for range in open gap between blocked periods", () => {
    expect(isRangeAvailable("2026-08-21", "2026-08-24", BLOCKED_AVAIL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateMinimumStay
// ---------------------------------------------------------------------------

describe("validateMinimumStay", () => {
  it("returns valid when nights >= listing minimum", () => {
    expect(validateMinimumStay("2026-08-01", "2026-08-04", OPEN_AVAIL, 2)).toEqual({
      valid: true,
    });
  });

  it("returns minimum_stay violation when below listing minimum", () => {
    const result = validateMinimumStay("2026-08-01", "2026-08-02", OPEN_AVAIL, 3);
    expect(result).toEqual({ valid: false, reason: "minimum_stay", required: 3, selected: 1 });
  });

  it("prefers per-date minimum over listing minimum", () => {
    // 2026-08-21 has minimumStayByDate = 3
    const result = validateMinimumStay("2026-08-21", "2026-08-23", BLOCKED_AVAIL, 2);
    expect(result).toEqual({ valid: false, reason: "minimum_stay", required: 3, selected: 2 });
  });

  it("returns valid when per-date minimum is satisfied", () => {
    const result = validateMinimumStay("2026-08-21", "2026-08-24", BLOCKED_AVAIL, 2);
    expect(result).toEqual({ valid: true });
  });

  it("returns maximum_stay violation when nights exceed max", () => {
    const result = validateMinimumStay("2026-08-01", "2026-08-15", OPEN_AVAIL, 2, 10);
    expect(result).toEqual({ valid: false, reason: "maximum_stay", maximum: 10, selected: 14 });
  });

  it("returns valid when nights equal listing maximum", () => {
    const result = validateMinimumStay("2026-08-01", "2026-08-11", OPEN_AVAIL, 2, 10);
    expect(result).toEqual({ valid: true });
  });

  it("ignores maximumStay when undefined", () => {
    const result = validateMinimumStay("2026-08-01", "2026-08-31", OPEN_AVAIL, 2, undefined);
    expect(result).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// validateCheckInDay
// ---------------------------------------------------------------------------

describe("validateCheckInDay", () => {
  it("returns valid when all days are allowed", () => {
    expect(validateCheckInDay("2026-08-01", OPEN_AVAIL)).toEqual({ valid: true });
  });

  it("returns valid when check-in day is in allowed list", () => {
    // 2026-08-03 is a Monday (day 1)
    expect(validateCheckInDay("2026-08-03", MON_ONLY_AVAIL)).toEqual({ valid: true });
  });

  it("returns checkin_day violation when day is not allowed", () => {
    // 2026-08-01 is a Saturday (day 6)
    const result = validateCheckInDay("2026-08-01", MON_ONLY_AVAIL);
    expect(result).toEqual({
      valid: false,
      reason: "checkin_day",
      allowedDays: [1],
      selectedDay: 6,
    });
  });

  it("returns valid when checkInAllowedDays is empty (all days open)", () => {
    const avail: AvailabilityResponse = { ...OPEN_AVAIL, checkInAllowedDays: [] };
    expect(validateCheckInDay("2026-08-01", avail)).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// findNearestAvailableRange
// ---------------------------------------------------------------------------

describe("findNearestAvailableRange", () => {
  it("returns the preferred range when it is available", () => {
    const result = findNearestAvailableRange("2026-08-01", 3, OPEN_AVAIL, 2);
    expect(result).toEqual({ checkIn: "2026-08-01", checkOut: "2026-08-04" });
  });

  it("skips blocked dates and finds the next open window", () => {
    // Blocked 2026-08-10 to 2026-08-20; prefer check-in 2026-08-09 for 5 nights
    const result = findNearestAvailableRange("2026-08-09", 5, BLOCKED_AVAIL, 2);
    // 2026-08-09 + 5 nights = 2026-08-14 → overlaps blocked period
    // Should find first valid date after blockage ends (2026-08-20) with 5 nights
    expect(result).not.toBeNull();
    if (result) {
      expect(isRangeAvailable(result.checkIn, result.checkOut, BLOCKED_AVAIL)).toBe(true);
      expect(computeNights(result.checkIn, result.checkOut)).toBe(5);
    }
  });

  it("returns null when no range found within maxSearchDays", () => {
    const allBlocked: AvailabilityResponse = {
      blockedRanges: [{ start: "2026-07-01", end: "2026-12-31", reason: "blocked" }],
      minimumStayByDate: {},
      checkInAllowedDays: [0, 1, 2, 3, 4, 5, 6],
    };
    const result = findNearestAvailableRange("2026-08-01", 3, allBlocked, 2, 30);
    expect(result).toBeNull();
  });

  it("skips days that violate minimum stay", () => {
    const result = findNearestAvailableRange("2026-08-01", 1, OPEN_AVAIL, 3);
    // nights=1 < listingMinimumStay=3, so it should be skipped — function needs nights >= listingMinimumStay
    // The function skips when actualNights < listingMinimumStay, so with nights=1, it returns null
    expect(result).toBeNull();
  });

  it("respects Monday-only check-in constraint", () => {
    // 2026-08-01 is Saturday; should advance to Monday 2026-08-03
    const result = findNearestAvailableRange("2026-08-01", 3, MON_ONLY_AVAIL, 2);
    expect(result).not.toBeNull();
    if (result) {
      // Check-in must be a Monday (UTC day 1)
      const day = new Date(`${result.checkIn}T00:00:00Z`).getUTCDay();
      expect(day).toBe(1);
    }
  });
});
