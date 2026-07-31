/**
 * Public-route allow-list for the auth service (WO-023).
 *
 * Any route absent from this list that lacks an authentication guard will
 * cause the route-coverage test to fail.  Add a route here only when it
 * genuinely requires no authentication — think carefully before expanding
 * this list.
 *
 * Format: "<METHOD> <path-pattern>"
 * Path patterns use Express-style colon parameters (e.g. :id).
 */
export const PUBLIC_ROUTES = new Set<string>([
  // Health checks (no auth needed for liveness/readiness probes)
  "GET /health/live",
  "GET /health/ready",

  // Registration and email verification
  "POST /auth/register",
  "POST /auth/verify-email",
  "POST /auth/resend-verification",

  // Login and token issuance
  "POST /auth/login",

  // Refresh (protected by HttpOnly cookie + CSRF, not Bearer auth)
  "POST /auth/refresh",

  // OAuth callback (code exchange — no prior token needed)
  "GET /auth/google/callback",

  // Password recovery
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
]);

/**
 * Routes that must have an authentication guard (non-exhaustive examples —
 * used in tests to assert specific routes are protected).
 */
export const PROTECTED_ROUTES = new Set<string>([
  "POST /auth/logout",
  "POST /auth/logout-all",
  "GET /auth/sessions",
  "DELETE /auth/sessions/:id",
]);
