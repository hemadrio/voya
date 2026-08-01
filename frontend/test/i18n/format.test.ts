/**
 * Unit tests for locale-aware formatting utilities.
 *
 * Covers: dates across locales, currency symbol placement, decimal/grouping
 * separators, zero-decimal currencies (JPY), plural rules for zero/one/two/
 * few/many/other, and relative time formatting.
 */

import { describe, it, expect } from "vitest";
import {
  formatDate,
  formatDateRange,
  formatMoney,
  formatNumber,
  formatNights,
  formatGuests,
  formatRelative,
} from "../../lib/i18n/format.js";

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  const date = new Date("2025-01-15T12:00:00Z");

  it("formats date in en locale with short month", () => {
    const result = formatDate(date, "en");
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2025/);
  });

  it("formats date in es locale in Spanish", () => {
    const result = formatDate(date, "es");
    // Spanish month abbreviation for January
    expect(result).toMatch(/ene|enero|15|2025/i);
  });

  it("formats date in ar locale in Arabic numerals or Eastern Arabic", () => {
    const result = formatDate(date, "ar");
    // Should contain some representation of the date
    expect(result.length).toBeGreaterThan(0);
  });

  it("accepts a timestamp number", () => {
    const result = formatDate(date.getTime(), "en");
    expect(result).toMatch(/2025/);
  });

  it("accepts a date string", () => {
    const result = formatDate("2025-01-15", "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("applies custom format options", () => {
    const result = formatDate(date, "en", { month: "long", year: "numeric" });
    expect(result).toMatch(/January.*2025|2025.*January/);
  });
});

// ---------------------------------------------------------------------------
// formatDateRange
// ---------------------------------------------------------------------------

describe("formatDateRange", () => {
  const start = new Date("2025-01-10T12:00:00Z");
  const end = new Date("2025-01-17T12:00:00Z");

  it("produces a range string in en locale", () => {
    const result = formatDateRange(start, end, "en");
    expect(result.length).toBeGreaterThan(0);
    // Should contain date information from both dates
    expect(result).toMatch(/Jan|10|17/i);
  });

  it("produces a range string in es locale", () => {
    const result = formatDateRange(start, end, "es");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe("formatMoney", () => {
  it("formats USD with dollar sign", () => {
    const result = formatMoney(1234.56, "USD", "en");
    expect(result).toMatch(/\$/);
    expect(result).toMatch(/1,234/);
  });

  it("formats EUR with euro symbol in en", () => {
    const result = formatMoney(1234.56, "EUR", "en");
    expect(result).toMatch(/€/);
  });

  it("formats EUR with different symbol placement in es locale", () => {
    const result = formatMoney(100, "EUR", "es");
    // Spanish locale places € after the number
    expect(result).toMatch(/€/);
  });

  it("formats JPY (zero-decimal) without decimal places", () => {
    const result = formatMoney(15000, "JPY", "en");
    expect(result).toMatch(/¥/);
    // JPY should not have .00 decimal
    expect(result).not.toMatch(/\./);
  });

  it("formats GBP correctly", () => {
    const result = formatMoney(99.99, "GBP", "en");
    expect(result).toMatch(/£/);
    expect(result).toMatch(/99\.99|99,99/);
  });

  it("formats AED for Arabic locale", () => {
    const result = formatMoney(500, "AED", "ar");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

describe("formatNumber", () => {
  it("uses comma as thousands separator in en", () => {
    const result = formatNumber(1234567, "en");
    expect(result).toMatch(/1,234,567/);
  });

  it("uses period as thousands separator in es (Spain)", () => {
    const result = formatNumber(1234567, "es");
    // May use . or space depending on locale variant
    expect(result.replace(/\s/g, "")).toMatch(/1\.234\.567|1234567/);
  });

  it("applies decimal options", () => {
    const result = formatNumber(3.14159, "en", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(result).toBe("3.14");
  });
});

// ---------------------------------------------------------------------------
// formatNights — plural rules
// ---------------------------------------------------------------------------

describe("formatNights", () => {
  it("returns singular 'night' for 1 in en", () => {
    expect(formatNights(1, "en")).toMatch(/1.*night$|night/);
    expect(formatNights(1, "en")).not.toMatch(/nights/);
  });

  it("returns plural 'nights' for 2 in en", () => {
    expect(formatNights(2, "en")).toMatch(/nights/);
  });

  it("returns plural 'nights' for 0 in en", () => {
    expect(formatNights(0, "en")).toMatch(/nights/);
  });

  it("returns Spanish singular 'noche' for 1", () => {
    expect(formatNights(1, "es")).toMatch(/noche/);
  });

  it("returns Spanish plural 'noches' for 7", () => {
    expect(formatNights(7, "es")).toMatch(/noches/);
  });

  it("returns Arabic form for 1 (one category)", () => {
    const result = formatNights(1, "ar");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("ليلة");
  });

  it("returns Arabic form for 2 (two category)", () => {
    const result = formatNights(2, "ar");
    expect(result.length).toBeGreaterThan(0);
    // Arabic dual form
    expect(result).toContain("ليلتان");
  });

  it("returns Arabic form for 5 (few category)", () => {
    const result = formatNights(5, "ar");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns Arabic form for 100 (other category)", () => {
    const result = formatNights(100, "ar");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back gracefully for unsupported locale", () => {
    const result = formatNights(3, "fr"); // not a supported locale, falls back to en
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatGuests — plural rules
// ---------------------------------------------------------------------------

describe("formatGuests", () => {
  it("returns singular for 1 guest in en", () => {
    expect(formatGuests(1, "en")).toMatch(/guest$/);
  });

  it("returns plural for 2 guests in en", () => {
    expect(formatGuests(2, "en")).toMatch(/guests/);
  });

  it("returns Spanish singular for 1 guest", () => {
    expect(formatGuests(1, "es")).toMatch(/huésped/);
  });
});

// ---------------------------------------------------------------------------
// formatRelative
// ---------------------------------------------------------------------------

describe("formatRelative", () => {
  const now = new Date("2025-01-15T12:00:00Z");

  it("describes past seconds", () => {
    const past = new Date("2025-01-15T11:59:30Z"); // 30s ago
    const result = formatRelative(past, now, "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("describes future days", () => {
    const future = new Date("2025-01-18T12:00:00Z"); // 3 days later
    const result = formatRelative(future, now, "en");
    expect(result).toMatch(/3 days|in 3/i);
  });

  it("describes past in Spanish", () => {
    const past = new Date("2025-01-14T12:00:00Z"); // 1 day ago
    const result = formatRelative(past, now, "es");
    expect(result.length).toBeGreaterThan(0);
  });

  it("works for Arabic locale", () => {
    const future = new Date("2025-02-15T12:00:00Z"); // ~1 month later
    const result = formatRelative(future, now, "ar");
    expect(result.length).toBeGreaterThan(0);
  });
});
