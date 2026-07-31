import { describe, it, expect } from "vitest";
import {
  parseSearchParams,
  buildSearchParams,
  filterReducer,
  getActiveFilters,
  formatPrice,
  computeNights,
} from "@/lib/search/params.js";
import type { SearchCriteria } from "@/lib/search/params.js";

// ---------------------------------------------------------------------------
// parseSearchParams — sanitizes hostile and malformed inputs
// ---------------------------------------------------------------------------

describe("parseSearchParams", () => {
  it("returns safe defaults for an empty params object", () => {
    const result = parseSearchParams({});
    expect(result.destination).toBe("");
    expect(result.guests).toBe(1);
    expect(result.rooms).toBe(1);
    expect(result.sort).toBe("recommended");
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.amenities).toEqual([]);
  });

  it("parses a valid destination string", () => {
    const result = parseSearchParams({ destination: "Paris" });
    expect(result.destination).toBe("Paris");
  });

  it("parses valid ISO check-in and check-out dates", () => {
    const result = parseSearchParams({ checkIn: "2025-06-01", checkOut: "2025-06-07" });
    expect(result.checkIn).toBe("2025-06-01");
    expect(result.checkOut).toBe("2025-06-07");
  });

  it("drops invalid date strings", () => {
    const result = parseSearchParams({ checkIn: "not-a-date", checkOut: "2025-13-99" });
    expect(result.checkIn).toBeUndefined();
    expect(result.checkOut).toBeUndefined();
  });

  it("coerces guests to integer within bounds", () => {
    expect(parseSearchParams({ guests: "5" }).guests).toBe(5);
  });

  it("clamps negative guests to 1", () => {
    expect(parseSearchParams({ guests: "-3" }).guests).toBe(1);
  });

  it("clamps guests above 20 to 20", () => {
    expect(parseSearchParams({ guests: "100" }).guests).toBe(20);
  });

  it("resets non-numeric guests to default 1", () => {
    expect(parseSearchParams({ guests: "abc" }).guests).toBe(1);
  });

  it("parses numeric price range", () => {
    const result = parseSearchParams({ minPrice: "50", maxPrice: "300" });
    expect(result.minPrice).toBe(50);
    expect(result.maxPrice).toBe(300);
  });

  it("drops negative price values", () => {
    const result = parseSearchParams({ minPrice: "-10" });
    expect(result.minPrice).toBeUndefined();
  });

  it("parses amenities as an array when repeated", () => {
    const result = parseSearchParams({ amenities: ["WiFi", "Pool"] });
    expect(result.amenities).toEqual(["WiFi", "Pool"]);
  });

  it("wraps single amenity string in an array", () => {
    const result = parseSearchParams({ amenities: "WiFi" });
    expect(result.amenities).toEqual(["WiFi"]);
  });

  it("parses freeCancellation=true", () => {
    expect(parseSearchParams({ freeCancellation: "true" }).freeCancellation).toBe(true);
  });

  it("parses freeCancellation=1", () => {
    expect(parseSearchParams({ freeCancellation: "1" }).freeCancellation).toBe(true);
  });

  it("parses freeCancellation=false as undefined (not set)", () => {
    expect(parseSearchParams({ freeCancellation: "false" }).freeCancellation).toBeUndefined();
  });

  it("rejects unknown sort key and falls back to recommended", () => {
    const result = parseSearchParams({ sort: "best_ever" });
    expect(result.sort).toBe("recommended");
  });

  it("accepts all valid sort values", () => {
    const valid = ["recommended", "price_asc", "price_desc", "rating_desc", "distance_asc"];
    for (const sort of valid) {
      expect(parseSearchParams({ sort }).sort).toBe(sort);
    }
  });

  it("clamps page below 1 to 1", () => {
    expect(parseSearchParams({ page: "0" }).page).toBe(1);
    expect(parseSearchParams({ page: "-5" }).page).toBe(1);
  });

  it("clamps pageSize above 50 to 20 (default fallback)", () => {
    expect(parseSearchParams({ pageSize: "999" }).pageSize).toBe(20);
  });

  it("ignores unknown params without throwing", () => {
    expect(() => parseSearchParams({ unknown_param: "xyz", injected: "'; DROP TABLE" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildSearchParams — round-trip serialization
// ---------------------------------------------------------------------------

describe("buildSearchParams", () => {
  function roundTrip(input: Record<string, string | string[] | undefined>): SearchCriteria {
    return parseSearchParams(
      Object.fromEntries(
        Array.from(buildSearchParams(parseSearchParams(input)).entries()),
      ) as Record<string, string>,
    );
  }

  it("round-trips destination", () => {
    expect(roundTrip({ destination: "Tokyo" }).destination).toBe("Tokyo");
  });

  it("round-trips check-in / check-out dates", () => {
    const rt = roundTrip({ checkIn: "2025-09-01", checkOut: "2025-09-07" });
    expect(rt.checkIn).toBe("2025-09-01");
    expect(rt.checkOut).toBe("2025-09-07");
  });

  it("round-trips amenities array", () => {
    const qs = buildSearchParams(parseSearchParams({ amenities: ["WiFi", "Pool"] }));
    expect(qs.getAll("amenities")).toEqual(["WiFi", "Pool"]);
  });

  it("omits default guests (1) from the URL", () => {
    const qs = buildSearchParams(parseSearchParams({ guests: "1" }));
    expect(qs.has("guests")).toBe(false);
  });

  it("includes guests when not default", () => {
    const qs = buildSearchParams(parseSearchParams({ guests: "3" }));
    expect(qs.get("guests")).toBe("3");
  });

  it("omits sort when recommended (default)", () => {
    const qs = buildSearchParams(parseSearchParams({ sort: "recommended" }));
    expect(qs.has("sort")).toBe(false);
  });

  it("includes sort when not default", () => {
    const qs = buildSearchParams(parseSearchParams({ sort: "price_asc" }));
    expect(qs.get("sort")).toBe("price_asc");
  });

  it("omits page when 1 (default)", () => {
    const qs = buildSearchParams(parseSearchParams({ page: "1" }));
    expect(qs.has("page")).toBe(false);
  });

  it("includes page when > 1", () => {
    const qs = buildSearchParams(parseSearchParams({ page: "2" }));
    expect(qs.get("page")).toBe("2");
  });

  it("includes freeCancellation=true when set", () => {
    const qs = buildSearchParams(parseSearchParams({ freeCancellation: "true" }));
    expect(qs.get("freeCancellation")).toBe("true");
  });

  it("omits freeCancellation when not set", () => {
    const qs = buildSearchParams(parseSearchParams({}));
    expect(qs.has("freeCancellation")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterReducer
// ---------------------------------------------------------------------------

describe("filterReducer", () => {
  const base: SearchCriteria = parseSearchParams({ destination: "Paris", page: "3" });

  it("SET_DESTINATION updates destination and resets page to 1", () => {
    const next = filterReducer(base, { type: "SET_DESTINATION", payload: "London" });
    expect(next.destination).toBe("London");
    expect(next.page).toBe(1);
  });

  it("SET_PRICE_RANGE sets min and max price and resets page", () => {
    const next = filterReducer(base, { type: "SET_PRICE_RANGE", payload: { min: 50, max: 200 } });
    expect(next.minPrice).toBe(50);
    expect(next.maxPrice).toBe(200);
    expect(next.page).toBe(1);
  });

  it("TOGGLE_AMENITY adds a new amenity and resets page", () => {
    const next = filterReducer(base, { type: "TOGGLE_AMENITY", payload: "WiFi" });
    expect(next.amenities).toContain("WiFi");
    expect(next.page).toBe(1);
  });

  it("TOGGLE_AMENITY removes an existing amenity", () => {
    const withWifi = filterReducer(base, { type: "TOGGLE_AMENITY", payload: "WiFi" });
    const removed = filterReducer(withWifi, { type: "TOGGLE_AMENITY", payload: "WiFi" });
    expect(removed.amenities).not.toContain("WiFi");
  });

  it("SET_TYPE sets the property type", () => {
    const next = filterReducer(base, { type: "SET_TYPE", payload: "villa" });
    expect(next.type).toBe("villa");
  });

  it("SET_TYPE with undefined clears the type", () => {
    const withType = filterReducer(base, { type: "SET_TYPE", payload: "villa" });
    const cleared = filterReducer(withType, { type: "SET_TYPE", payload: undefined });
    expect(cleared.type).toBeUndefined();
  });

  it("SET_FREE_CANCELLATION sets the flag", () => {
    const next = filterReducer(base, { type: "SET_FREE_CANCELLATION", payload: true });
    expect(next.freeCancellation).toBe(true);
  });

  it("SET_SORT updates sort and resets page", () => {
    const next = filterReducer(base, { type: "SET_SORT", payload: "price_asc" });
    expect(next.sort).toBe("price_asc");
    expect(next.page).toBe(1);
  });

  it("SET_PAGE sets page without resetting other fields", () => {
    const next = filterReducer(base, { type: "SET_PAGE", payload: 4 });
    expect(next.page).toBe(4);
    expect(next.destination).toBe(base.destination);
  });

  it("CLEAR_FILTERS resets filters but preserves destination/dates/guests", () => {
    const dirty = filterReducer(
      filterReducer(base, { type: "TOGGLE_AMENITY", payload: "WiFi" }),
      { type: "SET_PRICE_RANGE", payload: { min: 50, max: 200 } },
    );
    const cleared = filterReducer(dirty, { type: "CLEAR_FILTERS" });
    expect(cleared.amenities).toEqual([]);
    expect(cleared.minPrice).toBeUndefined();
    expect(cleared.maxPrice).toBeUndefined();
    expect(cleared.sort).toBe("recommended");
    expect(cleared.page).toBe(1);
    // Destination preserved
    expect(cleared.destination).toBe("Paris");
  });

  it("RESET replaces the entire state", () => {
    const newCriteria = parseSearchParams({ destination: "Berlin" });
    const next = filterReducer(base, { type: "RESET", payload: newCriteria });
    expect(next.destination).toBe("Berlin");
  });
});

// ---------------------------------------------------------------------------
// getActiveFilters
// ---------------------------------------------------------------------------

describe("getActiveFilters", () => {
  it("returns empty array when no filters are active", () => {
    const criteria = parseSearchParams({ destination: "Paris" });
    expect(getActiveFilters(criteria)).toHaveLength(0);
  });

  it("includes price range chip when min or max is set", () => {
    const criteria = parseSearchParams({ minPrice: "50", maxPrice: "200" });
    const filters = getActiveFilters(criteria);
    expect(filters.some((f) => f.key === "price")).toBe(true);
  });

  it("includes one chip per active amenity", () => {
    const criteria = parseSearchParams({ amenities: ["WiFi", "Pool"] });
    const filters = getActiveFilters(criteria);
    expect(filters.filter((f) => f.key.startsWith("amenity:"))).toHaveLength(2);
  });

  it("includes freeCancellation chip when set", () => {
    const criteria = parseSearchParams({ freeCancellation: "true" });
    const filters = getActiveFilters(criteria);
    expect(filters.some((f) => f.key === "freeCancellation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatPrice
// ---------------------------------------------------------------------------

describe("formatPrice", () => {
  it("formats USD prices", () => {
    expect(formatPrice(189, "USD")).toBe("$189");
  });

  it("formats EUR prices", () => {
    expect(formatPrice(120, "EUR", "de-DE")).toMatch(/120/);
  });

  it("falls back gracefully on unknown currency", () => {
    const result = formatPrice(100, "XYZ");
    expect(result).toContain("100");
  });
});

// ---------------------------------------------------------------------------
// computeNights
// ---------------------------------------------------------------------------

describe("computeNights", () => {
  it("computes correct night count", () => {
    expect(computeNights("2025-06-01", "2025-06-07")).toBe(6);
  });

  it("returns 0 when checkout equals checkin", () => {
    expect(computeNights("2025-06-01", "2025-06-01")).toBe(0);
  });

  it("returns 0 when checkout is before checkin", () => {
    expect(computeNights("2025-06-07", "2025-06-01")).toBe(0);
  });

  it("handles a DST boundary correctly (spring-forward in US)", () => {
    // US clocks spring forward 2025-03-09; a 7-night stay must still be 7
    const nights = computeNights("2025-03-08", "2025-03-15");
    expect(nights).toBe(7);
  });
});
