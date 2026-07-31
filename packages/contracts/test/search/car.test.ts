import { describe, expect, it } from "vitest";
import {
  CarRentalSearchRequestSchema,
  DROPOFF_AFTER_PICKUP_MESSAGE,
  FUTURE_PICKUP_DATE_MESSAGE,
} from "../../src/search/car.js";

const future = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const validPayload = () => ({
  pickupLocation: "LAX Airport",
  dropoffLocation: "LAX Airport",
  pickupDate: future(10 * 24 * 60 * 60 * 1000),
  dropoffDate: future(14 * 24 * 60 * 60 * 1000),
  carClass: "MIDSIZE" as const,
  currency: "USD",
});

describe("CarRentalSearchRequestSchema", () => {
  it("accepts a valid payload", () => {
    expect(CarRentalSearchRequestSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("rejects a pickup date that is not in the future", () => {
    const result = CarRentalSearchRequestSchema.safeParse({
      ...validPayload(),
      pickupDate: new Date(Date.now() - 1000).toISOString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "pickupDate");
      expect(issue?.message).toBe(FUTURE_PICKUP_DATE_MESSAGE);
    }
  });

  it("rejects a dropoff date on or before the pickup date", () => {
    const pickupDate = future(10 * 24 * 60 * 60 * 1000);
    const result = CarRentalSearchRequestSchema.safeParse({
      ...validPayload(),
      pickupDate,
      dropoffDate: pickupDate,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "dropoffDate");
      expect(issue?.message).toBe(DROPOFF_AFTER_PICKUP_MESSAGE);
    }
  });

  it("rejects an invalid car class", () => {
    const result = CarRentalSearchRequestSchema.safeParse({ ...validPayload(), carClass: "LUXURY" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty pickup location", () => {
    const result = CarRentalSearchRequestSchema.safeParse({ ...validPayload(), pickupLocation: "" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra keys", () => {
    const result = CarRentalSearchRequestSchema.safeParse({ ...validPayload(), extra: "nope" });
    expect(result.success).toBe(false);
  });
});
