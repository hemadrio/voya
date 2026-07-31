import type { ClientSession } from "@/lib/auth/session";

export const mockUser = {
  id: "user-abc-123",
  email: "test@example.com",
  firstName: "Jane",
  lastName: "Doe",
  locale: "en",
  currency: "USD",
};

export const mockLoginResponse = {
  accessToken: "access-token-abc",
  refreshToken: "refresh-token-xyz",
  expiresIn: 3600,
  user: mockUser,
};

export const mockClientSession: ClientSession = {
  user: mockUser,
  expiresAt: Date.now() + 3600 * 1000,
};

export const mockRegisterResponse = {
  userId: "user-new-456",
  emailVerificationRequired: false,
  accessToken: "access-token-new",
  refreshToken: "refresh-token-new",
  expiresIn: 3600,
  user: mockUser,
};

export const mockRegisterVerifyResponse = {
  userId: "user-new-789",
  emailVerificationRequired: true,
};

export const mockRefreshSuccessResponse = {
  accessToken: "access-token-refreshed",
  refreshToken: "refresh-token-refreshed",
  expiresIn: 3600,
};

// Standard error shapes

export const invalidCredsError = {
  status: 401,
  body: { error: { message: "Invalid credentials" } },
};

export const lockedAccountError = {
  status: 423,
  body: { error: { message: "Account locked" } },
};

export const expiredTokenError = {
  status: 401,
  body: { error: { code: "TOKEN_EXPIRED", message: "Token expired" } },
};

export const rateLimitedError = {
  status: 429,
  body: { error: { message: "Too many requests" } },
};

export const conflictError = {
  status: 409,
  body: { error: { message: "Email already registered" } },
};
