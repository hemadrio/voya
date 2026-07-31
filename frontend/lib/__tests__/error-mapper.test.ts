import { describe, expect, it } from "vitest";
import { mapEnvelopeToFormErrors, formErrorFromMessage } from "../error-mapper.js";
import type { ErrorEnvelope } from "@travel/contracts/errors";

function makeEnvelope(
  code: string,
  message: string,
  field?: string,
  reference = "ref-test-001"
): ErrorEnvelope {
  return {
    error: { code, message, ...(field !== undefined ? { field } : {}) },
    reference,
  };
}

const FLIGHT_FIELDS = ["departureAirport", "arrivalAirport", "departureDate", "passengers", "seatClass", "currency"] as const;

describe("mapEnvelopeToFormErrors — field attachment", () => {
  it("attaches message to matching top-level field", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Airport code must be a valid 3-letter IATA code", "departureAirport");
    const result = mapEnvelopeToFormErrors(envelope, [...FLIGHT_FIELDS]);

    expect(result.fieldErrors["departureAirport"]).toBe("Airport code must be a valid 3-letter IATA code");
    expect(result.formError).toBeUndefined();
    expect(result.reference).toBe("ref-test-001");
  });

  it("attaches to top-level segment when field is a nested path", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Invalid passport number", "passengers.0.passportNumber");
    const result = mapEnvelopeToFormErrors(envelope, ["passengers"]);

    expect(result.fieldErrors["passengers"]).toBe("Invalid passport number");
    expect(result.formError).toBeUndefined();
  });

  it("falls back to form-level banner when field path does not match any form field", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Unknown field error", "unknownField");
    const result = mapEnvelopeToFormErrors(envelope, [...FLIGHT_FIELDS]);

    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe("Unknown field error");
  });

  it("falls back to form-level banner when field is absent from envelope", () => {
    const envelope = makeEnvelope("FORBIDDEN", "Access denied");
    const result = mapEnvelopeToFormErrors(envelope, [...FLIGHT_FIELDS]);

    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe("Access denied");
  });

  it("preserves the reference in all branches", () => {
    const ref = "unique-ref-12345";
    const envelope = makeEnvelope("INTERNAL_ERROR", "Something went wrong", undefined, ref);
    const result = mapEnvelopeToFormErrors(envelope, [...FLIGHT_FIELDS]);

    expect(result.reference).toBe(ref);
  });
});

describe("mapEnvelopeToFormErrors — edge cases", () => {
  it("handles an empty fieldNames array — always falls back to form-level", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Error message", "someField");
    const result = mapEnvelopeToFormErrors(envelope, []);

    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe("Error message");
  });

  it("handles a field path with only a root segment (no dots)", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Required", "departureDate");
    const result = mapEnvelopeToFormErrors(envelope, ["departureDate"]);

    expect(result.fieldErrors["departureDate"]).toBe("Required");
  });

  it("handles a deeply nested path — still attaches to top-level field", () => {
    const envelope = makeEnvelope("VALIDATION_FAILED", "Invalid DOB", "passengers.2.dateOfBirth");
    const result = mapEnvelopeToFormErrors(envelope, ["passengers"]);

    expect(result.fieldErrors["passengers"]).toBe("Invalid DOB");
  });
});

describe("formErrorFromMessage", () => {
  it("produces a form-level error with no field errors", () => {
    const result = formErrorFromMessage("Network failure", "client-ref-abc");

    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe("Network failure");
    expect(result.reference).toBe("client-ref-abc");
  });
});
