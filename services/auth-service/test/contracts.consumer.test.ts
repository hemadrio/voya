/**
 * Consumer-driven fixture test for auth-service.
 * Owner: auth-service team.
 */
import { describe, expect, it } from "vitest";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
  AuthResponseSchema,
} from "@travel/contracts/auth";
import registerRequest from "../../../packages/contracts/test/fixtures/auth/register-request.json" with { type: "json" };
import loginRequest from "../../../packages/contracts/test/fixtures/auth/login-request.json" with { type: "json" };
import refreshRequest from "../../../packages/contracts/test/fixtures/auth/refresh-request.json" with { type: "json" };
import logoutRequest from "../../../packages/contracts/test/fixtures/auth/logout-request.json" with { type: "json" };
import oauthCallbackRequest from "../../../packages/contracts/test/fixtures/auth/oauth-callback-request.json" with { type: "json" };
import authResponse from "../../../packages/contracts/test/fixtures/auth/auth-response.json" with { type: "json" };

describe("auth-service consumer — RegisterRequest", () => {
  it("fixture validates against RegisterRequestSchema", () => {
    const result = RegisterRequestSchema.safeParse(registerRequest);
    expect(result.success).toBe(true);
  });

  it("rejects a registration with a weak password", () => {
    const result = RegisterRequestSchema.safeParse({ ...registerRequest, password: "weak" });
    expect(result.success).toBe(false);
  });
});

describe("auth-service consumer — LoginRequest", () => {
  it("fixture validates against LoginRequestSchema", () => {
    const result = LoginRequestSchema.safeParse(loginRequest);
    expect(result.success).toBe(true);
  });
});

describe("auth-service consumer — RefreshRequest", () => {
  it("fixture validates against RefreshRequestSchema", () => {
    const result = RefreshRequestSchema.safeParse(refreshRequest);
    expect(result.success).toBe(true);
  });
});

describe("auth-service consumer — LogoutRequest", () => {
  it("fixture validates against LogoutRequestSchema", () => {
    const result = LogoutRequestSchema.safeParse(logoutRequest);
    expect(result.success).toBe(true);
  });
});

describe("auth-service consumer — OAuthCallbackRequest", () => {
  it("fixture validates against OAuthCallbackRequestSchema", () => {
    const result = OAuthCallbackRequestSchema.safeParse(oauthCallbackRequest);
    expect(result.success).toBe(true);
  });
});

describe("auth-service consumer — AuthResponse", () => {
  it("fixture validates against AuthResponseSchema", () => {
    const result = AuthResponseSchema.safeParse(authResponse);
    expect(result.success).toBe(true);
  });

  it("rejects a response with unknown role", () => {
    const result = AuthResponseSchema.safeParse({ ...authResponse, role: "admin" });
    expect(result.success).toBe(false);
  });
});
