/**
 * Consumer-driven fixture test for user-service.
 * Owner: user-service team.
 */
import { describe, expect, it } from "vitest";
import { ProfileSchema, TravelPreferencesSchema } from "@travel/contracts/user";
import profile from "../../../packages/contracts/test/fixtures/user/profile.json" with { type: "json" };
import travelPreferences from "../../../packages/contracts/test/fixtures/user/travel-preferences.json" with { type: "json" };

describe("user-service consumer — Profile", () => {
  it("fixture validates against ProfileSchema", () => {
    const result = ProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it("rejects a profile with an unknown role", () => {
    const result = ProfileSchema.safeParse({ ...profile, role: "admin" });
    expect(result.success).toBe(false);
  });
});

describe("user-service consumer — TravelPreferences", () => {
  it("fixture validates against TravelPreferencesSchema", () => {
    const result = TravelPreferencesSchema.safeParse(travelPreferences);
    expect(result.success).toBe(true);
  });

  it("rejects preferences with unknown seat class", () => {
    const result = TravelPreferencesSchema.safeParse({ ...travelPreferences, preferredSeatClass: "PREMIUM_ECONOMY" });
    expect(result.success).toBe(false);
  });
});
