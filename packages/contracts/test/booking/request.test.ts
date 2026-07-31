import { describe, expect, it } from "vitest";
import { CreateBookingRequestSchema, PASSENGERS_REQUIRED_MESSAGE } from "../../src/booking/request.js";
import fixture from "../fixtures/booking/create-booking-request.json" with { type: "json" };

describe("CreateBookingRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(CreateBookingRequestSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an empty passengers array", () => {
    const result = CreateBookingRequestSchema.safeParse({ ...fixture, passengers: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "passengers");
      expect(issue?.message).toBe(PASSENGERS_REQUIRED_MESSAGE);
    }
  });

  it("rejects an invalid contact email", () => {
    const result = CreateBookingRequestSchema.safeParse({ ...fixture, contactEmail: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    const result = CreateBookingRequestSchema.safeParse({ ...fixture, extra: "nope" });
    expect(result.success).toBe(false);
  });
});
