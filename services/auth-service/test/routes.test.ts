/**
 * auth-service validation boundary tests.
 *
 * AC6/AC12: Valid and invalid payloads per route, status and envelope shape.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AuthDomain } from "../src/routes/auth.js";
import { PASSWORD_MIN_LENGTH_MESSAGE, EMAIL_INVALID_MESSAGE } from "@travel/contracts";

function makeDomain(): AuthDomain {
  return {
    register: vi.fn(async () => ({ userId: "u1", accessToken: "tok" })),
    login: vi.fn(async () => ({ userId: "u1", accessToken: "tok" })),
    refresh: vi.fn(async () => ({ accessToken: "new-tok" })),
    logout: vi.fn(async () => {}),
    oauthCallback: vi.fn(async () => ({ userId: "u1", accessToken: "tok" })),
    logoutAll: vi.fn(async () => ({ revokedCount: 1 })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => {}),
    forgotPassword: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    verifyEmail: vi.fn(async () => ({ verified: true as const })),
    resendVerification: vi.fn(async () => {}),
  };
}

const VALID_REGISTER = {
  email: "alice@example.com",
  password: "Password1",
  firstName: "Alice",
  lastName: "Smith",
};

describe("POST /auth/register — validation", () => {
  it("rejects invalid email with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.message).toContain(EMAIL_INVALID_MESSAGE);
    expect(domain.register).not.toHaveBeenCalled();
  });

  it("rejects short password with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(PASSWORD_MIN_LENGTH_MESSAGE);
    expect(domain.register).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema)", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER, extraField: "injected" });

    expect(res.status).toBe(400);
    expect(domain.register).not.toHaveBeenCalled();
  });

  it("valid register payload calls domain and returns 202", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/register").send(VALID_REGISTER);

    expect(res.status).toBe(202);
    expect(domain.register).toHaveBeenCalledOnce();
  });
});

describe("POST /auth/login — validation", () => {
  it("rejects empty body with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/login").send({});

    expect(res.status).toBe(400);
    expect(domain.login).not.toHaveBeenCalled();
  });

  it("valid login payload calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "alice@example.com", password: "Password1" });

    expect(res.status).toBe(200);
    expect(domain.login).toHaveBeenCalledOnce();
  });
});

describe("GET /auth/google/callback — query validation", () => {
  it("rejects missing code with 400", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).get("/auth/google/callback?state=abc");

    expect(res.status).toBe(400);
    expect(domain.oauthCallback).not.toHaveBeenCalled();
  });

  it("valid query calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).get("/auth/google/callback?code=auth-code&state=csrf-token");

    expect(res.status).toBe(200);
    expect(domain.oauthCallback).toHaveBeenCalledOnce();
  });
});
