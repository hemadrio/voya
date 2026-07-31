/**
 * Integration tests for the new WO-024 auth routes.
 *
 * Tests: logout (with/without actor), logout-all, session list, session
 * delete (incl. 404 cross-user), forgot-password response parity, and
 * reset-password validation boundary.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { AuthDomain } from "../src/routes/auth.js";
import { sessionNotFound, invalidOrExpiredToken, passwordReuseNotAllowed } from "@travel/contracts";

const ACTOR = { sub: "user-1", sid: "session-1", roles: ["traveler"], jti: "jti-1" };
const ACTOR_HEADER = JSON.stringify(ACTOR);

function makeDomain(): AuthDomain {
  return {
    register: vi.fn(async () => ({})),
    login: vi.fn(async () => ({})),
    refresh: vi.fn(async () => ({})),
    logout: vi.fn(async () => {}),
    oauthCallback: vi.fn(async () => ({})),
    logoutAll: vi.fn(async () => ({ revokedCount: 2 })),
    listSessions: vi.fn(async () => ({
      sessions: [
        {
          id: "session-1",
          createdAt: new Date("2024-01-01"),
          lastSeenAt: new Date("2024-01-02"),
          ipAddress: "1.2.3.4",
          userAgent: "TestBrowser",
          current: true,
        },
      ],
    })),
    deleteSession: vi.fn(async () => {}),
    forgotPassword: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    verifyEmail: vi.fn(async () => ({ verified: true as const })),
    resendVerification: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// POST /auth/logout — protected
// ---------------------------------------------------------------------------

describe("POST /auth/logout", () => {
  it("returns 401 when x-internal-actor header is absent", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/logout");

    expect(res.status).toBe(401);
    expect(domain.logout).not.toHaveBeenCalled();
  });

  it("returns 204 and calls domain.logout with sid and userId", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/logout")
      .set("x-internal-actor", ACTOR_HEADER);

    expect(res.status).toBe(204);
    expect(domain.logout).toHaveBeenCalledWith({ sid: "session-1", userId: "user-1" });
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout-all — protected
// ---------------------------------------------------------------------------

describe("POST /auth/logout-all", () => {
  it("returns 401 without actor header", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).post("/auth/logout-all");

    expect(res.status).toBe(401);
  });

  it("returns 200 with revokedCount", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/logout-all")
      .set("x-internal-actor", ACTOR_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.revokedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/sessions — protected
// ---------------------------------------------------------------------------

describe("GET /auth/sessions", () => {
  it("returns 401 without actor header", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).get("/auth/sessions");

    expect(res.status).toBe(401);
  });

  it("returns sessions array with safe columns only", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .get("/auth/sessions")
      .set("x-internal-actor", ACTOR_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toMatchObject({ id: "session-1", current: true });
    // Never expose token hashes
    expect(res.body.sessions[0]).not.toHaveProperty("refreshTokenHash");
    expect(res.body.sessions[0]).not.toHaveProperty("refresh_token_hash");
  });

  it("calls domain with userId and currentSid", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    await request(app).get("/auth/sessions").set("x-internal-actor", ACTOR_HEADER);

    expect(domain.listSessions).toHaveBeenCalledWith({ userId: "user-1", currentSid: "session-1" });
  });
});

// ---------------------------------------------------------------------------
// DELETE /auth/sessions/:id — protected
// ---------------------------------------------------------------------------

describe("DELETE /auth/sessions/:id", () => {
  it("returns 401 without actor header", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).delete("/auth/sessions/abc");

    expect(res.status).toBe(401);
  });

  it("returns 204 on success", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .delete("/auth/sessions/session-2")
      .set("x-internal-actor", ACTOR_HEADER);

    expect(res.status).toBe(204);
    expect(domain.deleteSession).toHaveBeenCalledWith({
      sessionId: "session-2",
      userId: "user-1",
      currentSid: "session-1",
    });
  });

  it("returns 404 when session does not belong to caller (domain throws SESSION_NOT_FOUND)", async () => {
    const domain = makeDomain();
    (domain.deleteSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(sessionNotFound());

    const app = createApp(domain);
    const res = await request(app)
      .delete("/auth/sessions/other-user-session")
      .set("x-internal-actor", ACTOR_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password — response parity
// ---------------------------------------------------------------------------

describe("POST /auth/forgot-password", () => {
  it("returns 202 with generic message when account exists", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe("If the address is valid you will receive reset instructions.");
    expect(domain.forgotPassword).toHaveBeenCalledWith({ email: "alice@example.com" });
  });

  it("returns identical 202 response when domain returns silently (non-existent email)", async () => {
    const domain = makeDomain();
    (domain.forgotPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const app = createApp(domain);

    const [resExists, resNotExist] = await Promise.all([
      request(app).post("/auth/forgot-password").send({ email: "alice@example.com" }),
      request(app).post("/auth/forgot-password").send({ email: "nobody@example.com" }),
    ]);

    // Response parity: same status and body regardless of account existence
    expect(resExists.status).toBe(resNotExist.status);
    expect(JSON.stringify(resExists.body)).toBe(JSON.stringify(resNotExist.body));
  });

  it("returns 400 for invalid email", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/forgot-password")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(domain.forgotPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

describe("POST /auth/reset-password", () => {
  it("returns 200 with reset: true on success", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: "some-valid-token", password: "NewPassword1" });

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(domain.resetPassword).toHaveBeenCalledWith({
      token: "some-valid-token",
      password: "NewPassword1",
    });
  });

  it("returns 400 when token is missing", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ password: "NewPassword1" });

    expect(res.status).toBe(400);
    expect(domain.resetPassword).not.toHaveBeenCalled();
  });

  it("returns 400 when password does not meet policy", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: "some-token", password: "weak" });

    expect(res.status).toBe(400);
    expect(domain.resetPassword).not.toHaveBeenCalled();
  });

  it("returns 400 when domain throws INVALID_OR_EXPIRED_TOKEN", async () => {
    const domain = makeDomain();
    (domain.resetPassword as ReturnType<typeof vi.fn>).mockRejectedValueOnce(invalidOrExpiredToken());

    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: "expired-token", password: "NewPassword1" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
  });

  it("returns 422 when domain throws PASSWORD_REUSE_NOT_ALLOWED", async () => {
    const domain = makeDomain();
    (domain.resetPassword as ReturnType<typeof vi.fn>).mockRejectedValueOnce(passwordReuseNotAllowed());

    const app = createApp(domain);
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: "good-token", password: "SameAsCurrentPass1" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PASSWORD_REUSE_NOT_ALLOWED");
  });
});
