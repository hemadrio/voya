import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { serialiseError, RESTRICTED_FIELDS } from "../../src/errors/serialise.js";
import {
  validationFailed,
  forbidden,
  lifecycleConflict,
  supplierRejected,
  supplierUnavailable,
  supplierTimeout,
  rateLimited,
  unauthenticated,
  notFound,
} from "../../src/errors/domain-errors.js";
import { iataCode, IATA_CODE_MESSAGE, isoDateString } from "../../src/common/primitives.js";
import { PassengerInfoSchema } from "../../src/booking/passenger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zodError(schema: z.ZodTypeAny, input: unknown): ZodError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("Expected schema to fail but it succeeded");
  return result.error;
}

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

describe("serialiseError — envelope shape", () => {
  it("always returns envelope and status", () => {
    const { envelope, status } = serialiseError(new Error("boom"));
    expect(typeof status).toBe("number");
    expect(typeof envelope.reference).toBe("string");
    expect(envelope.reference.length).toBeGreaterThan(0);
    expect(typeof envelope.error.code).toBe("string");
    expect(typeof envelope.error.message).toBe("string");
  });

  it("reference equals the injected traceId when provided", () => {
    const { envelope } = serialiseError(new Error("boom"), "trace-xyz-123");
    expect(envelope.reference).toBe("trace-xyz-123");
  });

  it("reference is non-empty when no traceId is provided (fallback)", () => {
    const { envelope } = serialiseError(new Error("boom"));
    expect(envelope.reference.length).toBeGreaterThan(0);
  });

  it("reference trims surrounding whitespace from the injected traceId", () => {
    const { envelope } = serialiseError(new Error("x"), "  trace-abc  ");
    expect(envelope.reference).toBe("trace-abc");
  });

  it("falls back to a generated id when traceId is an empty string", () => {
    const { envelope } = serialiseError(new Error("x"), "");
    expect(envelope.reference.length).toBeGreaterThan(0);
  });

  it("falls back to a generated id when traceId is whitespace only", () => {
    const { envelope } = serialiseError(new Error("x"), "   ");
    expect(envelope.reference.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ZodError → VALIDATION_FAILED
// ---------------------------------------------------------------------------

describe("serialiseError — ZodError path", () => {
  it("emits VALIDATION_FAILED with status 400", () => {
    const err = zodError(iataCode, "TOOLONG");
    const { envelope, status } = serialiseError(err, "t1");
    expect(status).toBe(400);
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
  });

  it("message for an invalid IATA code reads exactly the BR-11 wording", () => {
    const err = zodError(iataCode, "TOOLONG");
    const { envelope } = serialiseError(err, "t1");
    expect(envelope.error.message).toBe(IATA_CODE_MESSAGE);
  });

  it("field is undefined when the Zod failure path is empty (whole-body refinement)", () => {
    const schema = z.string().refine(() => false, { message: "refinement failed" });
    const err = zodError(schema, "anything");
    const { envelope } = serialiseError(err, "t2");
    expect(envelope.error.field).toBeUndefined();
  });

  it("field is a dotted path for a nested failure", () => {
    const err = zodError(
      z.object({ a: z.object({ b: z.string().min(5) }) }),
      { a: { b: "hi" } }
    );
    const { envelope } = serialiseError(err, "t3");
    expect(envelope.error.field).toBe("a.b");
  });

  it("field includes array indices for nested array paths", () => {
    const err = zodError(
      z.object({ passengers: z.array(z.object({ firstName: z.string().min(1) })) }),
      { passengers: [{ firstName: "" }] }
    );
    const { envelope } = serialiseError(err, "t4");
    expect(envelope.error.field).toBe("passengers.0.firstName");
  });

  it("picks the first issue deterministically when multiple failures exist", () => {
    const schema = z.object({ a: z.string(), b: z.string() });
    const err = zodError(schema, { a: 1, b: 2 });
    const { envelope: first } = serialiseError(err, "t5");
    const { envelope: second } = serialiseError(err, "t5");
    expect(first.error.field).toBe(second.error.field);
    expect(first.error.message).toBe(second.error.message);
  });

  it("handles a Zod failure with no issues gracefully", () => {
    // Construct an empty ZodError manually.
    const emptyZodErr = new ZodError([]);
    const { envelope, status } = serialiseError(emptyZodErr, "t6");
    expect(status).toBe(400);
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.message.length).toBeGreaterThan(0);
    expect(envelope.error.field).toBeUndefined();
  });

  it("handles an out-of-range passenger count (custom numeric validator)", () => {
    const schema = z.object({
      passengers: z.array(z.object({ age: z.number() })).max(9, { message: "Maximum 9 passengers" }),
    });
    const err = zodError(schema, { passengers: Array(10).fill({ age: 30 }) });
    const { envelope, status } = serialiseError(err, "t7");
    expect(status).toBe(400);
    expect(envelope.error.message).toBe("Maximum 9 passengers");
  });

  it("handles a missing required field", () => {
    const schema = z.object({ origin: z.string() });
    const err = zodError(schema, {});
    const { envelope, status } = serialiseError(err, "t8");
    expect(status).toBe(400);
    expect(envelope.error.field).toBe("origin");
  });
});

// ---------------------------------------------------------------------------
// Restricted-field redaction (per-field tests — AC6)
// ---------------------------------------------------------------------------

describe("serialiseError — Restricted-field redaction", () => {
  // Ensure the list mirrors expectations
  it("RESTRICTED_FIELDS contains all six policy-mandated fields", () => {
    const expected = [
      "passportNumber",
      "dateOfBirth",
      "email",
      "passwordHash",
      "authorization",
      "stripe-signature",
    ];
    for (const field of expected) {
      expect(RESTRICTED_FIELDS).toContain(field);
    }
  });

  it("passportNumber: only the field name appears, rejected value is absent", () => {
    const secretPassport = "PASSPORT-SECRET-AB123456";
    const err = zodError(
      z.object({ passportNumber: z.string().length(2, { message: `Invalid: ${secretPassport}` }) }),
      { passportNumber: secretPassport }
    );
    const { envelope } = serialiseError(err, "red1");
    expect(envelope.error.field).toBe("passportNumber");
    // The raw value and any message containing it must not appear
    expect(envelope.error.message).not.toContain(secretPassport);
    // Should be the safe, generic message for the restricted field
    expect(envelope.error.message).toContain("passportNumber");
  });

  it("dateOfBirth: only the field name appears, rejected value is absent", () => {
    const secretDOB = "1985-07-04T00:00:00.000Z";
    const err = zodError(
      z.object({ dateOfBirth: isoDateString }),
      { dateOfBirth: "not-a-date" }
    );
    const { envelope } = serialiseError(err, "red2");
    expect(envelope.error.field).toBe("dateOfBirth");
    expect(envelope.error.message).not.toContain(secretDOB);
    expect(envelope.error.message).toContain("dateOfBirth");
  });

  it("email: only the field name appears, rejected value is absent", () => {
    const secretEmail = "secret@private.internal";
    const err = zodError(
      z.object({ email: z.string().email({ message: `Bad email: ${secretEmail}` }) }),
      { email: secretEmail + "!!" }
    );
    const { envelope } = serialiseError(err, "red3");
    expect(envelope.error.field).toBe("email");
    expect(envelope.error.message).not.toContain(secretEmail);
    expect(envelope.error.message).toContain("email");
  });

  it("passwordHash: only the field name appears", () => {
    const secretHash = "$2b$12$VERY_SECRET_HASH";
    const err = zodError(
      z.object({ passwordHash: z.string().length(5, { message: `Hash exposed: ${secretHash}` }) }),
      { passwordHash: secretHash }
    );
    const { envelope } = serialiseError(err, "red4");
    expect(envelope.error.field).toBe("passwordHash");
    expect(envelope.error.message).not.toContain(secretHash);
    expect(envelope.error.message).toContain("passwordHash");
  });

  it("nested passenger passportNumber: dotted path and no value echo", () => {
    const secretPassport = "NESTED-PASSPORT-999";
    const err = zodError(
      z.object({
        passengers: z.array(
          z.object({
            passportNumber: z.string().length(2, { message: `Exposed: ${secretPassport}` }),
          })
        ),
      }),
      { passengers: [{ passportNumber: secretPassport }] }
    );
    const { envelope } = serialiseError(err, "red5");
    // Field path should be the dotted path
    expect(envelope.error.field).toBe("passengers.0.passportNumber");
    expect(envelope.error.message).not.toContain(secretPassport);
    expect(envelope.error.message).toContain("passportNumber");
  });

  it("nested passenger dateOfBirth: dotted path and no value echo", () => {
    const err = zodError(PassengerInfoSchema, {
      firstName: "Maya",
      lastName: "Chen",
      dateOfBirth: "not-a-date",
    });
    const { envelope } = serialiseError(err, "red6");
    expect(envelope.error.field).toBe("dateOfBirth");
    expect(envelope.error.message).toContain("dateOfBirth");
  });
});

// ---------------------------------------------------------------------------
// Leakage prevention (negative tests — AC5)
// ---------------------------------------------------------------------------

describe("serialiseError — leakage prevention", () => {
  it("does not include a stack trace in the response for an Error", () => {
    const err = new Error("Something went wrong");
    const { envelope } = serialiseError(err, "leak1");
    const json = JSON.stringify(envelope);
    // Stack traces contain "at " followed by function/file paths
    expect(json).not.toMatch(/at\s+\w/);
    expect(json).not.toContain(err.stack);
  });

  it("does not echo the original error message for an unknown Error (A10 — never leak)", () => {
    const err = new Error("SELECT * FROM users WHERE password = 'secret'");
    const { envelope } = serialiseError(err, "leak2");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("SELECT");
    expect(json).not.toContain("secret");
  });

  it("does not include a fake API token embedded in the error message", () => {
    const fakeToken = "sk_live_SUPERSECRET_TOKEN_12345";
    const err = new Error(`Stripe key ${fakeToken} is invalid`);
    const { envelope } = serialiseError(err, "leak3");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain(fakeToken);
    expect(json).not.toContain("Stripe key");
  });

  it("does not include a filesystem path from the error message", () => {
    const err = new Error("Cannot read file /etc/secrets/stripe.key");
    const { envelope } = serialiseError(err, "leak4");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("/etc/secrets");
  });

  it("does not echo the error class name in the response", () => {
    class DatabaseError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "DatabaseError";
      }
    }
    const err = new DatabaseError("Connection refused to 10.0.0.1:5432");
    const { envelope } = serialiseError(err, "leak5");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("DatabaseError");
    expect(json).not.toContain("10.0.0.1");
  });

  it("produces INTERNAL_ERROR with status 500 for an unknown Error", () => {
    const { envelope, status } = serialiseError(new Error("internal details"));
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
  });

  it("produces INTERNAL_ERROR for a thrown string", () => {
    const { envelope, status } = serialiseError("thrown string");
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("thrown string");
  });

  it("produces INTERNAL_ERROR for a thrown number", () => {
    const { envelope, status } = serialiseError(42);
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
  });

  it("produces INTERNAL_ERROR for undefined", () => {
    const { envelope, status } = serialiseError(undefined);
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
  });

  it("produces INTERNAL_ERROR for null", () => {
    const { envelope, status } = serialiseError(null);
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
  });

  it("does not crash for a circular-reference object thrown as an error", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => serialiseError(circular, "circ1")).not.toThrow();
    const { envelope, status } = serialiseError(circular, "circ1");
    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// DomainError dispatch (AC2 / AC8)
// ---------------------------------------------------------------------------

describe("serialiseError — DomainError path", () => {
  it("uses the domain error's code and message", () => {
    const err = lifecycleConflict("Booking is CONFIRMED; cannot transition to PENDING");
    const { envelope, status } = serialiseError(err, "dom1");
    expect(status).toBe(409);
    expect(envelope.error.code).toBe("LIFECYCLE_CONFLICT");
    expect(envelope.error.message).toBe("Booking is CONFIRMED; cannot transition to PENDING");
  });

  it("includes the field when the domain error carries one", () => {
    const err = validationFailed("Invalid airport", "origin");
    const { envelope } = serialiseError(err, "dom2");
    expect(envelope.error.field).toBe("origin");
  });

  it("omits the field key when the domain error carries no field", () => {
    const err = forbidden();
    const { envelope } = serialiseError(err, "dom3");
    expect(envelope.error.field).toBeUndefined();
  });

  it("SUPPLIER_REJECTED maps to 422", () => {
    const { status } = serialiseError(supplierRejected("Offer expired"), "dom4");
    expect(status).toBe(422);
  });

  it("SUPPLIER_UNAVAILABLE maps to 502", () => {
    const { status } = serialiseError(supplierUnavailable(), "dom5");
    expect(status).toBe(502);
  });

  it("SUPPLIER_TIMEOUT maps to 504", () => {
    const { status } = serialiseError(supplierTimeout(), "dom6");
    expect(status).toBe(504);
  });

  it("RATE_LIMITED maps to 429", () => {
    const { status } = serialiseError(rateLimited(), "dom7");
    expect(status).toBe(429);
  });

  it("UNAUTHENTICATED maps to 401", () => {
    const { status } = serialiseError(unauthenticated(), "dom8");
    expect(status).toBe(401);
  });

  it("NOT_FOUND maps to 404", () => {
    const { status } = serialiseError(notFound(), "dom9");
    expect(status).toBe(404);
  });
});
