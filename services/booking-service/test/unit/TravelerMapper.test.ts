/**
 * Unit tests for the PassengerInfo → CreateBookingTravelerInput mapper.
 *
 * Verifies the backfill mapping logic for:
 *   - Standard passenger with all fields
 *   - Passenger without passportNumber (null passportReference)
 *   - Passenger with extra unknown fields (strict schema strips them)
 *   - Passenger without email (optional)
 */

import { describe, it, expect } from "vitest";
import { mapPassengerToTravelerInput } from "../../src/domain/TravelerMapper.js";

describe("mapPassengerToTravelerInput", () => {
  it("maps a fully populated passenger correctly", () => {
    const input = mapPassengerToTravelerInput(
      {
        firstName: "Alice",
        lastName: "Smith",
        dateOfBirth: "1990-05-15",
        email: "alice@example.com",
        passportNumber: "AB1234567",
      },
      "booking-001",
    );

    expect(input).toEqual({
      bookingId: "booking-001",
      givenName: "Alice",
      familyName: "Smith",
      email: "alice@example.com",
      dateOfBirth: "1990-05-15",
      passportReference: "AB1234567",
    });
  });

  it("maps passenger without passportNumber — passportReference is null", () => {
    const input = mapPassengerToTravelerInput(
      {
        firstName: "Bob",
        lastName: "Jones",
        dateOfBirth: "1985-11-22",
        email: "bob@example.com",
      },
      "booking-002",
    );

    expect(input.passportReference).toBeNull();
    expect(input.givenName).toBe("Bob");
    expect(input.familyName).toBe("Jones");
  });

  it("maps passenger without email — email is undefined", () => {
    const input = mapPassengerToTravelerInput(
      {
        firstName: "Carol",
        lastName: "Williams",
        dateOfBirth: "1978-03-08",
      },
      "booking-003",
    );

    expect(input.email).toBeUndefined();
  });

  it("ignores extra unknown fields from the legacy JSON blob", () => {
    const input = mapPassengerToTravelerInput(
      {
        firstName: "David",
        lastName: "Brown",
        dateOfBirth: "1992-07-30",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unknownField: "should be ignored" as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        anotherExtra: 42 as any,
      },
      "booking-004",
    );

    // The mapper must not propagate unexpected fields
    expect(Object.keys(input)).toEqual([
      "bookingId",
      "givenName",
      "familyName",
      "dateOfBirth",
      "passportReference",
    ]);
  });

  it("trims whitespace from name fields", () => {
    const input = mapPassengerToTravelerInput(
      {
        firstName: "  Eve  ",
        lastName: "  Taylor  ",
        dateOfBirth: "2001-01-01",
      },
      "booking-005",
    );

    expect(input.givenName).toBe("Eve");
    expect(input.familyName).toBe("Taylor");
  });
});
