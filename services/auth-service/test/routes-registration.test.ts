/**
 * Route-layer tests for registration, email-verification, and resend endpoints.
 *
 * These tests exercise the HTTP boundary — request validation, response codes,
 * response body shape, and rate-limiting — using supertest against a real
 * Express app wired with a mock domain.  No database is involved.
 *
 * WO-020 acceptance criteria covered here:
 *   - POST /auth/register returns 202 with generic message for valid payload
 *   - POST /auth/register returns 400 for invalid schema
 *   - POST /auth/verify-email returns 200 { verified: true } on success
 *   - POST /auth/verify-email returns 400 on domain error
 *   - POST /auth/resend-verification returns 202 with generic message
 *   - POST /auth/resend-verification returns 400 for invalid email
 *   - Rate limiting returns 429 with Retry-After on exhaustion
 *   - Enumeration safety: register always returns same 202 body
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createInMemoryRateLimiter } from "../src/middleware/rateLimiter.js";
import type { AuthDomain } from "../src/routes/auth.js";
import {
  REGISTRATION_ACCEPTED_MESSAGE,
  invalidOrExpiredToken,
} from "@travel/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDomain(overrides: Partial<AuthDomain> = {}): AuthDomain {
  return {
    register: vi.fn(async () => ({ message: REGISTRATION_ACCEPTED_MESSAGE })),
    login: vi.fn(async () => ({})),
    refresh: vi.fn(async () => ({})),
    logout: vi.fn(async () => {}),
    oauthCallback: vi.fn(async () => ({})),
    logoutAll: vi.fn(async () => ({ revokedCount: 0 })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => {}),
    forgotPassword: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    verifyEmail: vi.fn(async () => ({ verified: true as const })),
    resendVerification: vi.fn(async () => {}),
    ...overrides,
  };
}

const VALID_REGISTER = {
  email: "alice@example.com",
  password: "Password1!",
  firstName: "Alice",
  lastName: "Smith",
};

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

describe("POST /auth/register — response", () => {
  it("returns 202 with generic message for valid payload", async () => {
    const app = createApp(makeDomain());
    const res = await request(app).post("/auth/register").send(VALID_REGISTER);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
  });

  it("returns 400 for missing email", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/register")
      .send({ password: "Password1!", firstName: "Alice", lastName: "Smith" });

    expect(res.status).toBe(400);
    expect(domain.register).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid email", async () => {
    const app = createApp(makeDomain());
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, email: "not-an-email" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for weak password", async () => {
    const app = createApp(makeDomain());
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, password: "weak" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown fields (strict schema)", async () => {
    const app = createApp(makeDomain());
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, injected: "evil" });

    expect(res.status).toBe(400);
  });

  it("returns same 202 body whether domain returns message or not (enumeration-safe)", async () => {
    // Simulate domain returning nothing meaningful — route always returns the constant
    const domain = makeDomain({ register: vi.fn(async () => ({})) });
    const app = createApp(domain);
    const res = await request(app).post("/auth/register").send(VALID_REGISTER);

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
  });
});

describe("POST /auth/register — password policy violation (422)", () => {
  it("returns 422 with structured violations when domain throws POLICY_VIOLATION", async () => {
    const violations = [
      { rule: "commonPassword", message: "Password is too common" },
      { rule: "similarToEmail", message: "Password is too similar to email" },
    ];
    const policyError = Object.assign(new Error("Password policy violation"), {
      code: "POLICY_VIOLATION" as const,
      violations,
    });
    const domain = makeDomain({
      register: vi.fn(async () => {
        throw policyError;
      }),
    });
    const app = createApp(domain);
    const res = await request(app).post("/auth/register").send(VALID_REGISTER);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PASSWORD_POLICY_VIOLATION");
    expect(res.body.error.violations).toHaveLength(2);
    expect(res.body.error.violations[0].rule).toBe("commonPassword");
  });
});

describe("POST /auth/register — rate limiting", () => {
  it("returns 429 with Retry-After after limit is exhausted", async () => {
    // Use a tight limiter: 2 requests per large window.
    const tightLimiter = createInMemoryRateLimiter({ maxHits: 2, windowSeconds: 3600 });
    const domain = makeDomain();
    const app = createApp(domain, {
      routerOptions: { registerLimiter: tightLimiter },
    });

    // First two requests pass.
    await request(app).post("/auth/register").send(VALID_REGISTER);
    await request(app).post("/auth/register").send(VALID_REGISTER);

    // Third request is rate-limited.
    const res = await request(app).post("/auth/register").send(VALID_REGISTER);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------

describe("POST /auth/verify-email — response", () => {
  it("returns 200 { verified: true } for valid token", async () => {
    const app = createApp(makeDomain());
    const res = await request(app)
      .post("/auth/verify-email")
      .send({ token: "some-valid-token" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
  });

  it("returns 400 for missing token", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/verify-email").send({});

    expect(res.status).toBe(400);
    expect(domain.verifyEmail).not.toHaveBeenCalled();
  });

  it("returns 400 for empty string token", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/verify-email").send({ token: "   " });

    expect(res.status).toBe(400);
    expect(domain.verifyEmail).not.toHaveBeenCalled();
  });

  it("propagates domain INVALID_OR_EXPIRED_TOKEN as 400", async () => {
    const domain = makeDomain({
      verifyEmail: vi.fn(async () => {
        throw invalidOrExpiredToken();
      }),
    });
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/verify-email")
      .send({ token: "bad-token" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
  });

  it("rejects unknown fields (strict schema)", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/verify-email")
      .send({ token: "abc", extra: "field" });

    expect(res.status).toBe(400);
    expect(domain.verifyEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /auth/resend-verification
// ---------------------------------------------------------------------------

describe("POST /auth/resend-verification — response", () => {
  it("returns 202 with generic message for valid email", async () => {
    const app = createApp(makeDomain());
    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "alice@example.com" });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
  });

  it("returns 400 for invalid email", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(domain.resendVerification).not.toHaveBeenCalled();
  });

  it("returns 400 for missing email", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/resend-verification").send({});

    expect(res.status).toBe(400);
    expect(domain.resendVerification).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown fields (strict schema)", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "alice@example.com", extra: "field" });

    expect(res.status).toBe(400);
    expect(domain.resendVerification).not.toHaveBeenCalled();
  });

  it("always returns 202 even when domain is a no-op (enumeration-safe)", async () => {
    // Domain does nothing — simulates unknown email case.
    const domain = makeDomain({ resendVerification: vi.fn(async () => {}) });
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
  });
});

describe("POST /auth/resend-verification — rate limiting", () => {
  it("returns 429 with Retry-After after limit is exhausted", async () => {
    const tightLimiter = createInMemoryRateLimiter({ maxHits: 2, windowSeconds: 3600 });
    const domain = makeDomain();
    const app = createApp(domain, {
      routerOptions: { resendVerificationLimiter: tightLimiter },
    });

    await request(app)
      .post("/auth/resend-verification")
      .send({ email: "alice@example.com" });
    await request(app)
      .post("/auth/resend-verification")
      .send({ email: "alice@example.com" });

    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "alice@example.com" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
