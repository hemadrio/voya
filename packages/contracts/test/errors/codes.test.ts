import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ERROR_STATUS_MAP,
  ALLOWED_HTTP_STATUSES,
  httpStatusForCode,
} from "../../src/errors/codes.js";

/** All ErrorCode values as a runtime array for iteration. */
const ALL_ERROR_CODES = Object.values(ErrorCode) as Array<
  (typeof ErrorCode)[keyof typeof ErrorCode]
>;

describe("ErrorCode", () => {
  it("exports at least the required 12 error codes", () => {
    const required = [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "LIFECYCLE_CONFLICT",
      "DUPLICATE_EMAIL",
      "SUPPLIER_REJECTED",
      "RATE_LIMITED",
      "SUPPLIER_UNAVAILABLE",
      "SUPPLIER_TIMEOUT",
      "INTERNAL_ERROR",
    ];
    for (const code of required) {
      expect(ALL_ERROR_CODES).toContain(code);
    }
  });

  it("values are plain strings (serialisable without loss)", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(typeof code).toBe("string");
    }
  });
});

describe("ERROR_STATUS_MAP — exhaustive mapping", () => {
  it("every ErrorCode maps to exactly one HTTP status", () => {
    for (const code of ALL_ERROR_CODES) {
      const status = ERROR_STATUS_MAP[code];
      expect(status, `${code} must have a mapped status`).toBeDefined();
      expect(typeof status).toBe("number");
    }
  });

  it("every mapped status is inside the allowed set (400/401/403/404/409/422/429/500/502/504)", () => {
    for (const code of ALL_ERROR_CODES) {
      const status = ERROR_STATUS_MAP[code];
      expect(
        ALLOWED_HTTP_STATUSES.has(status),
        `${code} maps to ${status} which is outside the allowed set`
      ).toBe(true);
    }
  });

  it("no ErrorCode maps to an unmapped fallback of undefined", () => {
    // Iterate the map keys to catch any accidental omission
    const mappedCodes = Object.keys(ERROR_STATUS_MAP);
    for (const code of ALL_ERROR_CODES) {
      expect(mappedCodes).toContain(code);
    }
  });
});

describe("httpStatusForCode", () => {
  it("returns 400 for VALIDATION_FAILED", () => {
    expect(httpStatusForCode("VALIDATION_FAILED")).toBe(400);
  });

  it("returns 401 for UNAUTHENTICATED", () => {
    expect(httpStatusForCode("UNAUTHENTICATED")).toBe(401);
  });

  it("returns 403 for FORBIDDEN", () => {
    expect(httpStatusForCode("FORBIDDEN")).toBe(403);
  });

  it("returns 404 for NOT_FOUND", () => {
    expect(httpStatusForCode("NOT_FOUND")).toBe(404);
  });

  it("returns 409 for CONFLICT", () => {
    expect(httpStatusForCode("CONFLICT")).toBe(409);
  });

  it("returns 409 for LIFECYCLE_CONFLICT", () => {
    expect(httpStatusForCode("LIFECYCLE_CONFLICT")).toBe(409);
  });

  it("returns 409 for DUPLICATE_EMAIL", () => {
    expect(httpStatusForCode("DUPLICATE_EMAIL")).toBe(409);
  });

  it("returns 422 for SUPPLIER_REJECTED", () => {
    expect(httpStatusForCode("SUPPLIER_REJECTED")).toBe(422);
  });

  it("returns 429 for RATE_LIMITED", () => {
    expect(httpStatusForCode("RATE_LIMITED")).toBe(429);
  });

  it("returns 502 for SUPPLIER_UNAVAILABLE", () => {
    expect(httpStatusForCode("SUPPLIER_UNAVAILABLE")).toBe(502);
  });

  it("returns 504 for SUPPLIER_TIMEOUT", () => {
    expect(httpStatusForCode("SUPPLIER_TIMEOUT")).toBe(504);
  });

  it("returns 500 for INTERNAL_ERROR", () => {
    expect(httpStatusForCode("INTERNAL_ERROR")).toBe(500);
  });

  it("returns 502 for EGRESS_DENIED", () => {
    expect(httpStatusForCode("EGRESS_DENIED")).toBe(502);
  });

  it("returns 422 for OFFER_NOT_BOOKABLE", () => {
    expect(httpStatusForCode("OFFER_NOT_BOOKABLE")).toBe(422);
  });
});
