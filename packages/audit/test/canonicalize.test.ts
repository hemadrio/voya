import { describe, it, expect } from "vitest";
import { canonicalize, buildAuditPreImage, GENESIS_HASH } from "../src/canonicalize.js";

describe("canonicalize", () => {
  it("serialises a flat object with sorted keys", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("produces the same output regardless of insertion order", () => {
    const obj1 = { b: "beta", a: "alpha" };
    const obj2 = { a: "alpha", b: "beta" };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });

  it("sorts nested object keys recursively", () => {
    const input = { outer: { z: "last", a: "first" }, b: 1 };
    const result = canonicalize(input);
    expect(result).toBe('{"b":1,"outer":{"a":"first","z":"last"}}');
  });

  it("preserves array element order", () => {
    const input = [3, 1, 2];
    expect(canonicalize(input)).toBe("[3,1,2]");
  });

  it("handles null values", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles string primitives", () => {
    expect(canonicalize("hello")).toBe('"hello"');
  });

  it("handles boolean primitives", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("omits undefined values from objects (JSON.stringify semantics)", () => {
    const input = { a: 1, b: undefined };
    expect(canonicalize(input)).toBe('{"a":1}');
  });

  it("sorts keys in deeply nested objects inside arrays", () => {
    const input = [{ z: 1, a: 2 }, { y: 3, b: 4 }];
    const result = canonicalize(input);
    expect(result).toBe('[{"a":2,"z":1},{"b":4,"y":3}]');
  });
});

describe("GENESIS_HASH", () => {
  it("is 64 hex zeros", () => {
    expect(GENESIS_HASH).toMatch(/^0{64}$/);
  });
});

describe("buildAuditPreImage", () => {
  const payload = {
    actorId: "user-1",
    actorRole: "traveler",
    action: "BOOKING_CREATED",
    resourceType: "booking",
    resourceId: "booking-1",
    previousState: null,
    newState: { status: "PENDING" },
    occurredAt: "2024-01-15T10:00:00.000Z",
    correlationId: null,
  };

  it("concatenates canonical payload with prevHash", () => {
    const preImage = buildAuditPreImage(payload, GENESIS_HASH);
    expect(preImage).toBe(canonicalize(payload) + GENESIS_HASH);
  });

  it("produces different pre-images for different prevHash values", () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const pi1 = buildAuditPreImage(payload, hash1);
    const pi2 = buildAuditPreImage(payload, hash2);
    expect(pi1).not.toBe(pi2);
  });

  it("produces different pre-images for different payloads with same prevHash", () => {
    const payload2 = { ...payload, action: "BOOKING_CONFIRMED" };
    const pi1 = buildAuditPreImage(payload, GENESIS_HASH);
    const pi2 = buildAuditPreImage(payload2, GENESIS_HASH);
    expect(pi1).not.toBe(pi2);
  });
});
