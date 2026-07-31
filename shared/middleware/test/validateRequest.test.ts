/**
 * Unit tests for the validateRequest middleware factory.
 *
 * AC11: Covers all four locations (body, query, params, headers), success
 *       attachment, failure envelope, and unknown-key handling via strict
 *       schema.
 *
 * No Express is needed — tests drive the middleware function directly.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { validateRequest } from "../validateRequest.js";
import { ErrorCode } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Minimal request / response mocks
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<{
  body: unknown;
  query: unknown;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}> = {}) {
  return {
    body: overrides.body ?? {},
    query: overrides.query ?? {},
    params: overrides.params ?? {},
    headers: overrides.headers ?? {},
    validated: undefined as unknown,
  };
}

function makeRes() {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    headersSent: false,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Body location
// ---------------------------------------------------------------------------

describe("validateRequest — body location", () => {
  const BodySchema = z.object({ name: z.string().min(1) }).strict();

  it("calls next() on valid body and attaches parsed value", () => {
    const next = vi.fn();
    const req = makeReq({ body: { name: "Alice" } });
    const res = makeRes();

    validateRequest({ body: BodySchema })(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect((req as unknown as { validated: { body: { name: string } } }).validated.body).toEqual({ name: "Alice" });
  });

  it("responds 400 and does NOT call next() on invalid body", () => {
    const next = vi.fn();
    const req = makeReq({ body: { name: "" } });
    const res = makeRes();

    validateRequest({ body: BodySchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("rejects unknown keys on strict schema", () => {
    const next = vi.fn();
    const req = makeReq({ body: { name: "Alice", extra: "injected" } });
    const res = makeRes();

    validateRequest({ body: BodySchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Query location
// ---------------------------------------------------------------------------

describe("validateRequest — query location", () => {
  const QuerySchema = z.object({ page: z.string().regex(/^\d+$/) }).strict();

  it("calls next() on valid query and attaches parsed value", () => {
    const next = vi.fn();
    const req = makeReq({ query: { page: "1" } });
    const res = makeRes();

    validateRequest({ query: QuerySchema })(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as unknown as { validated: { query: unknown } }).validated?.query).toEqual({ page: "1" });
  });

  it("responds 400 on invalid query", () => {
    const next = vi.fn();
    const req = makeReq({ query: { page: "abc" } });
    const res = makeRes();

    validateRequest({ query: QuerySchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Params location
// ---------------------------------------------------------------------------

describe("validateRequest — params location", () => {
  const ParamsSchema = z.object({ id: z.string().uuid() });

  it("calls next() on valid UUID param", () => {
    const next = vi.fn();
    const req = makeReq({ params: { id: "550e8400-e29b-41d4-a716-446655440000" } });
    const res = makeRes();

    validateRequest({ params: ParamsSchema })(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("responds 400 on non-UUID param", () => {
    const next = vi.fn();
    const req = makeReq({ params: { id: "not-a-uuid" } });
    const res = makeRes();

    validateRequest({ params: ParamsSchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect((res._body as { error: { field: string } }).error.field).toBe("id");
  });
});

// ---------------------------------------------------------------------------
// Headers location
// ---------------------------------------------------------------------------

describe("validateRequest — headers location", () => {
  const HeadersSchema = z.object({
    "x-idempotency-key": z.string().min(1),
  }).passthrough();

  it("calls next() when required header is present", () => {
    const next = vi.fn();
    const req = makeReq({ headers: { "x-idempotency-key": "key-123", "content-type": "application/json" } });
    const res = makeRes();

    validateRequest({ headers: HeadersSchema })(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("responds 400 when required header is missing", () => {
    const next = vi.fn();
    const req = makeReq({ headers: {} });
    const res = makeRes();

    validateRequest({ headers: HeadersSchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Multiple locations — first failure wins
// ---------------------------------------------------------------------------

describe("validateRequest — multiple locations", () => {
  const BodySchema = z.object({ name: z.string() }).strict();
  const ParamsSchema = z.object({ id: z.string().uuid() });

  it("stops at first failure and does not validate remaining locations", () => {
    const next = vi.fn();
    // Headers fail → should stop before body
    const HeadersSchema = z.object({ "x-required": z.string().min(1) }).passthrough();
    const req = makeReq({
      headers: {},       // fails headers
      body: { name: 1 }, // would also fail body
    });
    const res = makeRes();

    validateRequest({ headers: HeadersSchema, body: BodySchema })(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  it("attaches both body and params on success", () => {
    const next = vi.fn();
    const req = makeReq({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      body: { name: "test" },
    });
    const res = makeRes();

    validateRequest({ params: ParamsSchema, body: BodySchema })(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    const validated = (req as unknown as { validated: { body?: unknown; params?: unknown } }).validated;
    expect(validated.body).toEqual({ name: "test" });
    expect(validated.params).toMatchObject({ id: "550e8400-e29b-41d4-a716-446655440000" });
  });
});

// ---------------------------------------------------------------------------
// Envelope shape assertions
// ---------------------------------------------------------------------------

describe("validateRequest — failure envelope shape", () => {
  const Schema = z.object({ value: z.number() }).strict();

  it("failure envelope has code, message, field, and reference", () => {
    const next = vi.fn();
    const req = makeReq({ body: { value: "not-a-number" } });
    const res = makeRes();

    validateRequest({ body: Schema })(req as never, res as never, next);

    const body = res._body as { error: { code: string; message: string; field?: string }; reference: string };
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(typeof body.error.message).toBe("string");
    expect(body.reference).toBeDefined();
  });

  it("uses X-Trace-Id as the reference when present", () => {
    const next = vi.fn();
    const req = makeReq({
      body: { value: "bad" },
      headers: { "x-trace-id": "trace-abc-123" },
    });
    const res = makeRes();

    validateRequest({ body: Schema })(req as never, res as never, next);

    const body = res._body as { reference: string };
    expect(body.reference).toBe("trace-abc-123");
  });
});
