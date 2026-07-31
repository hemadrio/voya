import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, ErrorDetailSchema } from "../../src/errors/envelope.js";

describe("ErrorDetailSchema", () => {
  it("accepts a valid error detail with all fields", () => {
    const result = ErrorDetailSchema.safeParse({
      code: "VALIDATION_FAILED",
      message: "Airport code must be a valid 3-letter IATA code",
      field: "origin",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("VALIDATION_FAILED");
      expect(result.data.message).toBe("Airport code must be a valid 3-letter IATA code");
      expect(result.data.field).toBe("origin");
    }
  });

  it("accepts a valid error detail without the optional field", () => {
    const result = ErrorDetailSchema.safeParse({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.field).toBeUndefined();
    }
  });

  it("rejects an error detail with missing code", () => {
    const result = ErrorDetailSchema.safeParse({ message: "something" });
    expect(result.success).toBe(false);
  });

  it("rejects an error detail with missing message", () => {
    const result = ErrorDetailSchema.safeParse({ code: "VALIDATION_FAILED" });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys (strict mode)", () => {
    const result = ErrorDetailSchema.safeParse({
      code: "NOT_FOUND",
      message: "Not found",
      field: "id",
      extra: "forbidden",
    });
    expect(result.success).toBe(false);
  });
});

describe("ErrorEnvelopeSchema", () => {
  const validEnvelope = {
    error: {
      code: "VALIDATION_FAILED",
      message: "Airport code must be a valid 3-letter IATA code",
      field: "origin",
    },
    reference: "01j3h4k-7f2a9b",
  };

  it("accepts a valid envelope with all fields", () => {
    const result = ErrorEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reference).toBe("01j3h4k-7f2a9b");
      expect(result.data.error.code).toBe("VALIDATION_FAILED");
      expect(result.data.error.field).toBe("origin");
    }
  });

  it("accepts a valid envelope without optional field", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
      reference: "ref-abc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope with an empty reference", () => {
    const result = ErrorEnvelopeSchema.safeParse({ ...validEnvelope, reference: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing the error object", () => {
    const result = ErrorEnvelopeSchema.safeParse({ reference: "ref-abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope missing the reference field", () => {
    const result = ErrorEnvelopeSchema.safeParse({ error: validEnvelope.error });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys (strict mode — no additional keys emitted)", () => {
    const result = ErrorEnvelopeSchema.safeParse({ ...validEnvelope, extra: "nope" });
    expect(result.success).toBe(false);
  });

  it("is stable across repeated parse calls (shape does not mutate)", () => {
    const first = ErrorEnvelopeSchema.safeParse(validEnvelope);
    const second = ErrorEnvelopeSchema.safeParse(validEnvelope);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.data).toEqual(second.data);
    }
  });
});
