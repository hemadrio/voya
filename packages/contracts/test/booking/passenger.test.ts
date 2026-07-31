import { describe, expect, it } from "vitest";
import { NAME_REQUIRED_MESSAGE, PASSENGER_EMAIL_INVALID_MESSAGE, PassengerInfoSchema } from "../../src/booking/passenger.js";

const validPassenger = () => ({
  firstName: "Maya",
  lastName: "Chen",
  dateOfBirth: "1990-03-14T00:00:00.000Z",
  email: "maya.chen@example.com",
});

describe("PassengerInfoSchema", () => {
  it("accepts a valid passenger", () => {
    expect(PassengerInfoSchema.safeParse(validPassenger()).success).toBe(true);
  });

  it("accepts a passenger without the optional email or passport", () => {
    const { email: _email, ...rest } = validPassenger();
    expect(PassengerInfoSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects an empty first name", () => {
    const result = PassengerInfoSchema.safeParse({ ...validPassenger(), firstName: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(NAME_REQUIRED_MESSAGE);
  });

  it("rejects an invalid email", () => {
    const result = PassengerInfoSchema.safeParse({ ...validPassenger(), email: "not-an-email" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSENGER_EMAIL_INVALID_MESSAGE);
  });
});
