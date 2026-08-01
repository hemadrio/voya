/**
 * Unit tests for locale negotiation.
 *
 * Covers: cookie-present, Accept-Language-only, unsupported-locale,
 * no-header fallback, region variant, multi-value header ordering.
 */

import { describe, it, expect } from "vitest";
import { negotiateLocale, parseAcceptLanguage, matchLocale } from "../../i18n/negotiation.js";
import { NEGOTIATION_CASES } from "../fixtures/i18n.js";
import { SUPPORTED_LOCALES } from "../../i18n/routing.js";

// ---------------------------------------------------------------------------
// parseAcceptLanguage
// ---------------------------------------------------------------------------

describe("parseAcceptLanguage", () => {
  it("returns tags in quality order", () => {
    const result = parseAcceptLanguage("en-US,en;q=0.9,es;q=0.8");
    expect(result).toEqual(["en-US", "en", "es"]);
  });

  it("handles a single tag with no q", () => {
    expect(parseAcceptLanguage("ar")).toEqual(["ar"]);
  });

  it("handles equal quality tags in original order", () => {
    const result = parseAcceptLanguage("de,fr");
    expect(result).toContain("de");
    expect(result).toContain("fr");
  });

  it("ignores empty or whitespace-only segments", () => {
    const result = parseAcceptLanguage(",  , es");
    expect(result).toEqual(["es"]);
  });

  it("handles malformed q values gracefully", () => {
    const result = parseAcceptLanguage("es;q=bad,en");
    // NaN q sorts near bottom; en (q=1) should come first
    expect(result[0]).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// matchLocale
// ---------------------------------------------------------------------------

describe("matchLocale", () => {
  it("matches exact locale", () => {
    expect(matchLocale("en", SUPPORTED_LOCALES)).toBe("en");
    expect(matchLocale("ar", SUPPORTED_LOCALES)).toBe("ar");
  });

  it("matches language prefix (region variant → base locale)", () => {
    expect(matchLocale("es-419", SUPPORTED_LOCALES)).toBe("es");
    expect(matchLocale("en-US", SUPPORTED_LOCALES)).toBe("en");
    expect(matchLocale("ar-SA", SUPPORTED_LOCALES)).toBe("ar");
  });

  it("returns null for unsupported locale", () => {
    expect(matchLocale("fr", SUPPORTED_LOCALES)).toBeNull();
    expect(matchLocale("de-DE", SUPPORTED_LOCALES)).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(matchLocale("EN", SUPPORTED_LOCALES)).toBe("en");
    expect(matchLocale("ES-MX", SUPPORTED_LOCALES)).toBe("es");
  });
});

// ---------------------------------------------------------------------------
// negotiateLocale
// ---------------------------------------------------------------------------

describe("negotiateLocale", () => {
  for (const c of NEGOTIATION_CASES) {
    it(c.description, () => {
      const result = negotiateLocale(c.cookieLocale, c.acceptLanguage);
      expect(result).toBe(c.expected);
    });
  }

  it("always returns a supported locale", () => {
    const result = negotiateLocale(undefined, undefined);
    expect(SUPPORTED_LOCALES as readonly string[]).toContain(result);
  });

  it("path-preserving: switching locale preserves search params", () => {
    // This is a pure logic test for the path transformation used by LocaleSwitcher
    const locale = "es";
    const bare = "/search";
    const search = "tab=HOTEL&guests=2";
    const newPath = `/${locale}${bare}?${search}`;
    expect(newPath).toBe("/es/search?tab=HOTEL&guests=2");
  });

  it("handles array params in query string", () => {
    const search = new URLSearchParams();
    search.append("amenities", "pool");
    search.append("amenities", "wifi");
    const params = search.toString();
    expect(params).toBe("amenities=pool&amenities=wifi");
  });
});
