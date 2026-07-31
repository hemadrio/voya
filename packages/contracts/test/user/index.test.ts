import { describe, expect, it } from "vitest";
import { ProfileSchema, TravelPreferencesSchema } from "../../src/user/index.js";
import profileFixture from "../fixtures/user/profile.json" with { type: "json" };
import preferencesFixture from "../fixtures/user/travel-preferences.json" with { type: "json" };

describe("ProfileSchema", () => {
  it("accepts the committed fixture", () => {
    expect(ProfileSchema.safeParse(profileFixture).success).toBe(true);
  });

  it("rejects an invalid role", () => {
    expect(ProfileSchema.safeParse({ ...profileFixture, role: "admin" }).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(ProfileSchema.safeParse({ ...profileFixture, email: "nope" }).success).toBe(false);
  });
});

describe("TravelPreferencesSchema", () => {
  it("accepts the committed fixture", () => {
    expect(TravelPreferencesSchema.safeParse(preferencesFixture).success).toBe(true);
  });

  it("accepts an object with only the required userId", () => {
    expect(TravelPreferencesSchema.safeParse({ userId: "user_1" }).success).toBe(true);
  });

  it("rejects an invalid preferred seat class", () => {
    const result = TravelPreferencesSchema.safeParse({ ...preferencesFixture, preferredSeatClass: "SUPERSONIC" });
    expect(result.success).toBe(false);
  });
});
