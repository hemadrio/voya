/**
 * Fixture session objects for unit and integration tests.
 *
 * These are synthetic sessions — no real credentials are present.
 * Tokens use a placeholder string that is structurally valid for bearer
 * header injection but will be rejected by the backend if accidentally sent.
 */

export interface FixtureSession {
  userId: string;
  email: string;
  accessToken: string;
  expiresAt: string;
}

export const SESSION_AUTHENTICATED: FixtureSession = {
  userId: "user_fixture_01234567",
  email: "traveler@example.com",
  accessToken: "fixture.access.token.for.testing.only",
  expiresAt: "2030-12-31T23:59:59.000Z",
};

export const SESSION_EXPIRED: FixtureSession = {
  userId: "user_fixture_01234567",
  email: "traveler@example.com",
  accessToken: "fixture.expired.token.for.testing.only",
  expiresAt: "2020-01-01T00:00:00.000Z",
};

export const SESSION_ANONYMOUS: null = null;
