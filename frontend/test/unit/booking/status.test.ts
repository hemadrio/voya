import { describe, it, expect } from "vitest";
import {
  deriveTab,
  dateToTimezoneMs,
  msUntilDeadline,
  isDeadlineImminent,
  isDeadlinePassed,
  formatCountdown,
} from "../../../lib/bookings/status.js";
import { generateIcs } from "../../../lib/calendar/ics.js";

// ---------------------------------------------------------------------------
// Fixed reference clock: 2026-08-01T12:00:00Z (noon UTC on 2026-08-01)
// ---------------------------------------------------------------------------
const NOW_MS = Date.UTC(2026, 7, 1, 12, 0, 0); // month is 0-indexed → August

// ---------------------------------------------------------------------------
// dateToTimezoneMs
// ---------------------------------------------------------------------------

describe("dateToTimezoneMs", () => {
  it("converts YYYY-MM-DD to midnight local UTC ms in UTC zone", () => {
    const ms = dateToTimezoneMs("2026-08-01", "UTC");
    expect(ms).toBe(Date.UTC(2026, 7, 1, 0, 0, 0));
  });

  it("converts YYYY-MM-DD for Europe/Paris in summer (CEST = UTC+2)", () => {
    // Midnight on 2026-08-11 in Paris = 2026-08-10T22:00:00Z
    const ms = dateToTimezoneMs("2026-08-11", "Europe/Paris");
    expect(ms).toBe(Date.UTC(2026, 7, 10, 22, 0, 0));
  });

  it("converts YYYY-MM-DD for Asia/Makassar (WITA = UTC+8, no DST)", () => {
    // Midnight on 2026-07-29 in Makassar = 2026-07-28T16:00:00Z
    const ms = dateToTimezoneMs("2026-07-29", "Asia/Makassar");
    expect(ms).toBe(Date.UTC(2026, 6, 28, 16, 0, 0));
  });
});

// ---------------------------------------------------------------------------
// deriveTab — 6 canonical cases
// ---------------------------------------------------------------------------

describe("deriveTab", () => {
  it("upcoming — checkIn is tomorrow (future)", () => {
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-08-02", checkOut: "2026-08-07", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("upcoming");
  });

  it("in_progress — today equals checkIn date in UTC", () => {
    // checkIn 2026-08-01 UTC midnight = 2026-08-01T00:00:00Z; now is noon → in_progress
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-08-01", checkOut: "2026-08-07", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("in_progress");
  });

  it("in_progress — mid-stay (checkIn past, checkOut future)", () => {
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-07-25", checkOut: "2026-08-10", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("in_progress");
  });

  it("in_progress — checkout day (checkOut midnight not yet passed)", () => {
    // checkOut 2026-08-02 UTC midnight = 2026-08-02T00:00:00Z; now is 2026-08-01 noon → in_progress
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-07-28", checkOut: "2026-08-02", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("in_progress");
  });

  it("past — checkOut midnight has passed", () => {
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-07-01", checkOut: "2026-07-07", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("past");
  });

  it("cancelled — cancelled status regardless of dates", () => {
    const tab = deriveTab(
      { status: "cancelled", checkIn: "2026-09-01", checkOut: "2026-09-07", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("cancelled");
  });

  it("cancelled — failed status maps to cancelled tab", () => {
    const tab = deriveTab(
      { status: "failed", checkIn: "2026-09-01", checkOut: "2026-09-07", timezone: "UTC" },
      NOW_MS,
    );
    expect(tab).toBe("cancelled");
  });

  it("uses listing timezone for in-progress classification", () => {
    // Asia/Makassar = UTC+8. At NOW_MS (2026-08-01T12:00Z) it is 2026-08-01T20:00 local.
    // checkIn 2026-08-01 local midnight = 2026-07-31T16:00Z — already passed.
    // checkOut 2026-08-05 local midnight = 2026-08-04T16:00Z — not yet passed.
    const tab = deriveTab(
      { status: "confirmed", checkIn: "2026-08-01", checkOut: "2026-08-05", timezone: "Asia/Makassar" },
      NOW_MS,
    );
    expect(tab).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Deadline helpers
// ---------------------------------------------------------------------------

describe("msUntilDeadline", () => {
  it("returns positive ms when deadline is in the future", () => {
    const future = new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString();
    const ms = msUntilDeadline(future, NOW_MS);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeCloseTo(3 * 24 * 60 * 60 * 1000, -3);
  });

  it("returns negative ms when deadline has passed", () => {
    const past = new Date(NOW_MS - 60_000).toISOString();
    expect(msUntilDeadline(past, NOW_MS)).toBeLessThan(0);
  });

  it("returns null for null deadline", () => {
    expect(msUntilDeadline(null, NOW_MS)).toBeNull();
  });

  it("returns null for undefined deadline", () => {
    expect(msUntilDeadline(undefined, NOW_MS)).toBeNull();
  });
});

describe("isDeadlineImminent", () => {
  const THRESHOLD_48H = 48 * 60 * 60 * 1000;

  it("returns true when deadline is within threshold", () => {
    const soon = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString();
    expect(isDeadlineImminent(soon, THRESHOLD_48H, NOW_MS)).toBe(true);
  });

  it("returns false when deadline is beyond threshold", () => {
    const later = new Date(NOW_MS + 72 * 60 * 60 * 1000).toISOString();
    expect(isDeadlineImminent(later, THRESHOLD_48H, NOW_MS)).toBe(false);
  });

  it("returns false when deadline has already passed", () => {
    const past = new Date(NOW_MS - 1000).toISOString();
    expect(isDeadlineImminent(past, THRESHOLD_48H, NOW_MS)).toBe(false);
  });

  it("returns false for null deadline", () => {
    expect(isDeadlineImminent(null, THRESHOLD_48H, NOW_MS)).toBe(false);
  });
});

describe("isDeadlinePassed", () => {
  it("returns true when deadline has passed", () => {
    const past = new Date(NOW_MS - 1000).toISOString();
    expect(isDeadlinePassed(past, NOW_MS)).toBe(true);
  });

  it("returns false when deadline is in the future", () => {
    const future = new Date(NOW_MS + 1000).toISOString();
    expect(isDeadlinePassed(future, NOW_MS)).toBe(false);
  });

  it("returns false for null deadline", () => {
    expect(isDeadlinePassed(null, NOW_MS)).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("formats multiple days correctly", () => {
    expect(formatCountdown(2 * 24 * 60 * 60 * 1000)).toBe("2 days");
  });

  it("formats exactly 1 day", () => {
    expect(formatCountdown(24 * 60 * 60 * 1000)).toBe("1 day");
  });

  it("formats hours (< 1 day)", () => {
    expect(formatCountdown(3 * 60 * 60 * 1000)).toBe("3 hours");
  });

  it("formats exactly 1 hour", () => {
    expect(formatCountdown(60 * 60 * 1000)).toBe("1 hour");
  });

  it("formats minutes (< 1 hour)", () => {
    expect(formatCountdown(10 * 60 * 1000)).toBe("10 minutes");
  });

  it("formats 1 minute", () => {
    expect(formatCountdown(60 * 1000)).toBe("1 minute");
  });

  it("returns deadline-passed message for zero or negative ms", () => {
    expect(formatCountdown(0)).toBe("Deadline passed");
    expect(formatCountdown(-1000)).toBe("Deadline passed");
  });
});

// ---------------------------------------------------------------------------
// ICS generation (AC7)
// ---------------------------------------------------------------------------

describe("generateIcs", () => {
  const event = {
    reference: "VYA-2026-001",
    title: "Grand Villa Paris",
    checkIn: "2026-09-15",
    checkOut: "2026-09-20",
    timezone: "Europe/Paris",
    location: "Paris, France",
    description: "Booking VYA-2026-001",
  };

  it("produces a valid ICS string with required components", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
  });

  it("uses DATE value type for DTSTART and DTEND", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");
    expect(ics).toContain("DTEND;VALUE=DATE:20260920");
  });

  it("sets UID to booking-{reference}@voya.travel", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("UID:booking-VYA-2026-001@voya.travel");
  });

  it("includes SUMMARY from title", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("SUMMARY:Grand Villa Paris");
  });

  it("escapes commas in LOCATION per RFC 5545", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("LOCATION:Paris\\, France");
  });

  it("includes X-WR-TIMEZONE with the listing timezone", () => {
    const ics = generateIcs(event);
    expect(ics).toContain("X-WR-TIMEZONE:Europe/Paris");
  });

  it("uses CRLF line endings throughout", () => {
    const ics = generateIcs(event);
    // Every line break should be CRLF
    expect(ics).toMatch(/\r\n/);
    // Split on CRLF — should yield > 5 lines
    const lines = ics.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
  });

  it("folds lines longer than 75 octets", () => {
    const longDesc = "A".repeat(100);
    const ics = generateIcs({ ...event, description: longDesc });
    // Non-continuation lines (not starting with space) must be ≤ 75 chars
    for (const line of ics.split("\r\n")) {
      if (line.startsWith(" ")) continue; // continuation line
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  it("omits LOCATION when not provided", () => {
    const ics = generateIcs({ ...event, location: undefined });
    expect(ics).not.toContain("LOCATION:");
  });

  it("omits DESCRIPTION when not provided", () => {
    const ics = generateIcs({ ...event, description: undefined });
    expect(ics).not.toContain("DESCRIPTION:");
  });
});
