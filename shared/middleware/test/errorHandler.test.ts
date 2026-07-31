/**
 * Unit tests for shared/middleware/errorHandler.ts
 *
 * AC5: error envelope shape — error.code, error.message, optional error.field,
 *      top-level reference; never leaks stack, SQL, or internal message.
 * AC6: Status semantics: 400 validation, 401 unauth, 403 forbidden, 404 not found,
 *      409 conflict/lifecycle, 422 supplier-rejected, 429 rate-limited,
 *      502 supplier-unavailable, 504 supplier-timeout, 500 unmapped.
 * WO-007: Logs at warn for 4xx, error for 5xx; resolves reference from
 *         req.correlationId > x-correlation-id header > x-trace-id header.
 */
import { describe, it, expect, vi } from "vitest";
import { ZodError } from "zod";
import { createErrorHandler } from "../errorHandler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

type FakeReq = {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
};

type FakeRes = {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
};

function makeReq(opts: Partial<FakeReq> = {}): FakeReq {
  return { headers: {}, ...opts };
}

function makeRes(headersSent = false): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    headersSent,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeDomainError(code: string, message: string, field?: string) {
  const err = new Error(message) as Error & { code: string; field?: string };
  err.code = code;
  if (field !== undefined) err.field = field;
  return err;
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

describe("createErrorHandler — envelope shape", () => {
  it("emits error.code, error.message, and reference for a ZodError", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(
      new ZodError([{
        code: "too_small", minimum: 1, type: "string", inclusive: true,
        message: "Required", path: ["name"],
      }]),
      makeReq({ correlationId: VALID_ULID }),
      res,
      vi.fn(),
    );
    const body = res.body as Record<string, unknown>;
    expect(res.statusCode).toBe(400);
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("reference");
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("VALIDATION_FAILED");
  });

  it("uses req.correlationId as the reference (highest priority)", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(new Error("test"), makeReq({ correlationId: VALID_ULID }), res, vi.fn());
    expect((res.body as Record<string, unknown>)["reference"]).toBe(VALID_ULID);
  });

  it("falls back to x-correlation-id header", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(new Error("test"), makeReq({ headers: { "x-correlation-id": VALID_ULID } }), res, vi.fn());
    expect((res.body as Record<string, unknown>)["reference"]).toBe(VALID_ULID);
  });

  it("falls back to x-trace-id header as last resort", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(new Error("test"), makeReq({ headers: { "x-trace-id": VALID_ULID } }), res, vi.fn());
    expect((res.body as Record<string, unknown>)["reference"]).toBe(VALID_ULID);
  });

  it("generates a fallback reference when no correlation context is available", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(new Error("test"), makeReq(), res, vi.fn());
    const ref = (res.body as Record<string, unknown>)["reference"];
    expect(typeof ref).toBe("string");
    expect((ref as string).length).toBeGreaterThan(0);
  });

  it("never leaks internal message or stack trace", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(new Error("secret DB password"), makeReq(), res, vi.fn());
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("secret DB password");
    expect(body).not.toContain("stack");
  });

  it("includes error.field for validation errors with a field path", () => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(
      makeDomainError("VALIDATION_FAILED", "Invalid airport", "departureAirport"),
      makeReq(),
      res,
      vi.fn(),
    );
    const err = (res.body as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["field"]).toBe("departureAirport");
  });
});

// ---------------------------------------------------------------------------
// Status code mapping (AC6)
// ---------------------------------------------------------------------------

describe("createErrorHandler — exhaustive status code mapping", () => {
  const cases: Array<[string, ReturnType<typeof makeDomainError> | Error, number]> = [
    ["VALIDATION_FAILED → 400", makeDomainError("VALIDATION_FAILED", "bad input"), 400],
    ["UNAUTHENTICATED → 401", makeDomainError("UNAUTHENTICATED", "not auth"), 401],
    ["FORBIDDEN → 403", makeDomainError("FORBIDDEN", "denied"), 403],
    ["NOT_FOUND → 404", makeDomainError("NOT_FOUND", "not found"), 404],
    ["CONFLICT → 409", makeDomainError("CONFLICT", "conflict"), 409],
    ["LIFECYCLE_CONFLICT → 409", makeDomainError("LIFECYCLE_CONFLICT", "lifecycle"), 409],
    ["DUPLICATE_EMAIL → 409", makeDomainError("DUPLICATE_EMAIL", "dup email"), 409],
    ["SUPPLIER_REJECTED → 422", makeDomainError("SUPPLIER_REJECTED", "rejected"), 422],
    ["OFFER_NOT_BOOKABLE → 422", makeDomainError("OFFER_NOT_BOOKABLE", "not bookable"), 422],
    ["RATE_LIMITED → 429", makeDomainError("RATE_LIMITED", "rate"), 429],
    ["SUPPLIER_UNAVAILABLE → 502", makeDomainError("SUPPLIER_UNAVAILABLE", "down"), 502],
    ["EGRESS_DENIED → 502", makeDomainError("EGRESS_DENIED", "ssrf"), 502],
    ["SUPPLIER_TIMEOUT → 504", makeDomainError("SUPPLIER_TIMEOUT", "timeout"), 504],
    ["unknown Error → 500", new Error("boom"), 500],
  ];

  it.each(cases)("%s", (_label, error, expectedStatus) => {
    const handler = createErrorHandler();
    const res = makeRes();
    handler(error, makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(expectedStatus);
  });
});

// ---------------------------------------------------------------------------
// Logger level routing (WO-007 AC5)
// ---------------------------------------------------------------------------

describe("createErrorHandler — logger level routing", () => {
  it("logs at warn for 4xx (NOT_FOUND)", () => {
    const logger = makeLogger();
    const handler = createErrorHandler({ logger });
    handler(makeDomainError("NOT_FOUND", "nf"), makeReq(), makeRes(), vi.fn());
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs at warn for 400 (VALIDATION_FAILED)", () => {
    const logger = makeLogger();
    const handler = createErrorHandler({ logger });
    handler(makeDomainError("VALIDATION_FAILED", "bad"), makeReq(), makeRes(), vi.fn());
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs at error for 5xx (unknown Error)", () => {
    const logger = makeLogger();
    const handler = createErrorHandler({ logger });
    handler(new Error("internal"), makeReq(), makeRes(), vi.fn());
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs at error for 504 (SUPPLIER_TIMEOUT)", () => {
    const logger = makeLogger();
    const handler = createErrorHandler({ logger });
    handler(makeDomainError("SUPPLIER_TIMEOUT", "timeout"), makeReq(), makeRes(), vi.fn());
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("includes correlationId in log context object", () => {
    const logger = makeLogger();
    const handler = createErrorHandler({ logger });
    handler(makeDomainError("NOT_FOUND", "nf"), makeReq({ correlationId: VALID_ULID }), makeRes(), vi.fn());
    const logObj = logger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logObj?.["correlationId"]).toBe(VALID_ULID);
  });

  it("does not throw when no logger is provided", () => {
    const handler = createErrorHandler();
    expect(() => handler(new Error("x"), makeReq(), makeRes(), vi.fn())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// headersSent guard
// ---------------------------------------------------------------------------

describe("createErrorHandler — headersSent guard", () => {
  it("delegates to next(err) without writing status when headers are already sent", () => {
    const handler = createErrorHandler();
    const res = makeRes(true);
    const next = vi.fn();
    const err = new Error("too late");
    handler(err, makeReq(), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBe(0);
  });
});
