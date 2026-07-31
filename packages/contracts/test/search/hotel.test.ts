import { describe, expect, it } from "vitest";
import {
  CHECK_OUT_AFTER_CHECK_IN_MESSAGE,
  GUEST_COUNT_MESSAGE,
  HotelSearchRequestSchema,
} from "../../src/search/hotel.js";

const validPayload = () => ({
  location: "Paris, France",
  checkInDate: "2030-06-01T00:00:00.000Z",
  checkOutDate: "2030-06-05T00:00:00.000Z",
  guests: 2,
  starRating: 4 as const,
  currency: "USD",
});

describe("HotelSearchRequestSchema", () => {
  it("accepts a valid payload", () => {
    expect(HotelSearchRequestSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("accepts an omitted optional starRating", () => {
    const { starRating: _starRating, ...rest } = validPayload();
    const result = HotelSearchRequestSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.starRating).toBeUndefined();
  });

  it("rejects a same-day stay (check-out equal to check-in) naming checkOutDate", () => {
    const result = HotelSearchRequestSchema.safeParse({
      ...validPayload(),
      checkInDate: "2030-06-01T00:00:00.000Z",
      checkOutDate: "2030-06-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "checkOutDate");
      expect(issue?.message).toBe(CHECK_OUT_AFTER_CHECK_IN_MESSAGE);
    }
  });

  it("rejects a check-out date before the check-in date", () => {
    const result = HotelSearchRequestSchema.safeParse({
      ...validPayload(),
      checkInDate: "2030-06-05T00:00:00.000Z",
      checkOutDate: "2030-06-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "checkOutDate");
      expect(issue?.message).toBe(CHECK_OUT_AFTER_CHECK_IN_MESSAGE);
    }
  });

  it("rejects an invalid star rating", () => {
    const result = HotelSearchRequestSchema.safeParse({ ...validPayload(), starRating: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects a guest count of 0", () => {
    const result = HotelSearchRequestSchema.safeParse({ ...validPayload(), guests: 0 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(GUEST_COUNT_MESSAGE);
  });

  it("rejects unknown extra keys", () => {
    const result = HotelSearchRequestSchema.safeParse({ ...validPayload(), extra: "nope" });
    expect(result.success).toBe(false);
  });
});
