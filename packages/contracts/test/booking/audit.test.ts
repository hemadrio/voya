import { describe, expect, it } from "vitest";
import {
  AUDIT_REDACT_KEYS,
  sanitiseAuditPayload,
  toSanitisedPayload,
} from "../../src/booking/audit.js";

describe("AUDIT_REDACT_KEYS", () => {
  it("includes identity-document fields", () => {
    expect(AUDIT_REDACT_KEYS.has("email")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("passwordHash")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("dateOfBirth")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("passportNumber")).toBe(true);
  });

  it("includes credential and token fields", () => {
    expect(AUDIT_REDACT_KEYS.has("authorization")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("Authorization")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("stripe-signature")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("token")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("accessToken")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("refreshToken")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("secret")).toBe(true);
    expect(AUDIT_REDACT_KEYS.has("password")).toBe(true);
  });
});

describe("sanitiseAuditPayload", () => {
  it("returns primitives unchanged", () => {
    expect(sanitiseAuditPayload(42)).toBe(42);
    expect(sanitiseAuditPayload("hello")).toBe("hello");
    expect(sanitiseAuditPayload(true)).toBe(true);
    expect(sanitiseAuditPayload(null)).toBeNull();
  });

  it("does not mutate the original — returns a copy", () => {
    const original = { email: "user@example.com", name: "Alice" };
    sanitiseAuditPayload(original);
    expect(original.email).toBe("user@example.com"); // original unchanged
  });

  it("redacts keys at the top level", () => {
    const result = sanitiseAuditPayload({
      email: "alice@example.com",
      passportNumber: "AB1234567",
      amount: 199,
    }) as Record<string, unknown>;
    expect(result["email"]).toBe("[REDACTED]");
    expect(result["passportNumber"]).toBe("[REDACTED]");
    expect(result["amount"]).toBe(199);
  });

  it("redacts keys in nested objects", () => {
    const result = sanitiseAuditPayload({
      outer: { token: "tok_secret", value: 10 },
    }) as Record<string, unknown>;
    const outer = result["outer"] as Record<string, unknown>;
    expect(outer["token"]).toBe("[REDACTED]");
    expect(outer["value"]).toBe(10);
  });

  it("redacts keys inside array elements", () => {
    const result = sanitiseAuditPayload({
      passengers: [
        { name: "Bob", email: "bob@example.com" },
        { name: "Carol", dateOfBirth: "1985-07-01" },
      ],
    }) as Record<string, unknown>;
    const passengers = result["passengers"] as Record<string, unknown>[];
    expect(passengers[0]?.["email"]).toBe("[REDACTED]");
    expect(passengers[0]?.["name"]).toBe("Bob");
    expect(passengers[1]?.["dateOfBirth"]).toBe("[REDACTED]");
    expect(passengers[1]?.["name"]).toBe("Carol");
  });

  it("handles deeply nested structures", () => {
    const result = sanitiseAuditPayload({
      a: { b: { c: { secret: "very-secret", safe: "ok" } } },
    }) as Record<string, unknown>;
    const c = ((result["a"] as Record<string, unknown>)["b"] as Record<string, unknown>)["c"] as Record<string, unknown>;
    expect(c["secret"]).toBe("[REDACTED]");
    expect(c["safe"]).toBe("ok");
  });

  it("accepts a custom redactKeys set", () => {
    const custom = new Set(["customField"]);
    const result = sanitiseAuditPayload(
      { customField: "hidden", email: "keep@example.com" },
      custom,
    ) as Record<string, unknown>;
    expect(result["customField"]).toBe("[REDACTED]");
    expect(result["email"]).toBe("keep@example.com"); // not in custom set
  });

  it("handles arrays of primitives unchanged", () => {
    const result = sanitiseAuditPayload({ tags: ["economy", "direct"] }) as Record<string, unknown>;
    expect(result["tags"]).toEqual(["economy", "direct"]);
  });

  it("preserves non-redacted values of various types", () => {
    const date = new Date("2024-01-15");
    const result = sanitiseAuditPayload({
      amount: 9900,
      confirmed: true,
      status: "CONFIRMED",
      date,
    }) as Record<string, unknown>;
    expect(result["amount"]).toBe(9900);
    expect(result["confirmed"]).toBe(true);
    expect(result["status"]).toBe("CONFIRMED");
    expect(result["date"]).toBe(date);
  });
});

describe("toSanitisedPayload", () => {
  it("returns the sanitised result", () => {
    const result = toSanitisedPayload({ amount: 99, email: "x@y.com" });
    expect((result as Record<string, unknown>)["amount"]).toBe(99);
    expect((result as Record<string, unknown>)["email"]).toBe("[REDACTED]");
  });

  it("allows the branded type to be used at call sites requiring SanitisedPayload", () => {
    const sanitised = toSanitisedPayload({ amount: 10 });
    // TypeScript would catch an accidental un-sanitised pass; this confirms runtime works
    expect(sanitised).toBeDefined();
  });
});
