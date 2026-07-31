import { describe, expect, it } from "vitest";
import {
  AuthResponseSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
  PASSWORD_COMPLEXITY_MESSAGE,
  PASSWORD_MIN_LENGTH_MESSAGE,
  RefreshRequestSchema,
  RegisterRequestSchema,
} from "../../src/auth/index.js";
import registerFixture from "../fixtures/auth/register-request.json" with { type: "json" };
import loginFixture from "../fixtures/auth/login-request.json" with { type: "json" };
import refreshFixture from "../fixtures/auth/refresh-request.json" with { type: "json" };
import logoutFixture from "../fixtures/auth/logout-request.json" with { type: "json" };
import oauthFixture from "../fixtures/auth/oauth-callback-request.json" with { type: "json" };
import authResponseFixture from "../fixtures/auth/auth-response.json" with { type: "json" };

describe("RegisterRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(RegisterRequestSchema.safeParse(registerFixture).success).toBe(true);
  });

  it("normalises the email to lowercase", () => {
    const result = RegisterRequestSchema.safeParse({ ...registerFixture, email: "Maya.Chen@Example.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("maya.chen@example.com");
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = RegisterRequestSchema.safeParse({ ...registerFixture, password: "Ab1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSWORD_MIN_LENGTH_MESSAGE);
  });

  it("rejects a password missing complexity requirements", () => {
    const result = RegisterRequestSchema.safeParse({ ...registerFixture, password: "alllowercase1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(PASSWORD_COMPLEXITY_MESSAGE);
  });

  it("rejects an invalid email", () => {
    expect(RegisterRequestSchema.safeParse({ ...registerFixture, email: "not-an-email" }).success).toBe(false);
  });
});

describe("LoginRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(LoginRequestSchema.safeParse(loginFixture).success).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(LoginRequestSchema.safeParse({ ...loginFixture, password: "" }).success).toBe(false);
  });
});

describe("RefreshRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(RefreshRequestSchema.safeParse(refreshFixture).success).toBe(true);
  });

  it("rejects an empty refresh token", () => {
    expect(RefreshRequestSchema.safeParse({ refreshToken: "" }).success).toBe(false);
  });
});

describe("LogoutRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(LogoutRequestSchema.safeParse(logoutFixture).success).toBe(true);
  });

  it("rejects a missing refresh token", () => {
    expect(LogoutRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("OAuthCallbackRequestSchema", () => {
  it("accepts the committed fixture", () => {
    expect(OAuthCallbackRequestSchema.safeParse(oauthFixture).success).toBe(true);
  });

  it("rejects a missing state", () => {
    const { state: _state, ...rest } = oauthFixture as Record<string, unknown>;
    expect(OAuthCallbackRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("AuthResponseSchema", () => {
  it("accepts the committed fixture", () => {
    expect(AuthResponseSchema.safeParse(authResponseFixture).success).toBe(true);
  });

  it("rejects an invalid role", () => {
    expect(AuthResponseSchema.safeParse({ ...authResponseFixture, role: "admin" }).success).toBe(false);
  });
});
