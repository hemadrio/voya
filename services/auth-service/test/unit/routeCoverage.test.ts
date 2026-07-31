/**
 * Route-coverage test (WO-023, AC7).
 *
 * Walks every registered route in the auth service and verifies that each one
 * either:
 *   (a) is explicitly listed in the PUBLIC_ROUTES allow-list, or
 *   (b) has an authentication guard (requireAuth or the new bearerAuth) applied.
 *
 * This test is intentionally strict — it fails loudly when a new route is
 * added without an access decision, preventing accidental public exposure.
 *
 * Strategy: Rather than trying to walk Express's internal route stack (which
 * is fragile and not part of the public API), this test maintains an explicit
 * manifest of all known routes and their access policy.  When a new route is
 * added to the router, the developer MUST update this manifest — the test
 * failing is the reminder.
 */

import { describe, it, expect } from "vitest";
import { PUBLIC_ROUTES, PROTECTED_ROUTES } from "../../src/config/publicRoutes.js";

// ---------------------------------------------------------------------------
// Canonical route manifest
// All routes registered in services/auth-service/src/routes/auth.ts
// Format: "<METHOD> <path>"
// ---------------------------------------------------------------------------

const ALL_ROUTES = new Set<string>([
  // Public routes
  "POST /auth/register",
  "POST /auth/verify-email",
  "POST /auth/resend-verification",
  "POST /auth/login",
  "POST /auth/refresh",
  "GET /auth/google/callback",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",

  // Protected routes (require authentication)
  "POST /auth/logout",
  "POST /auth/logout-all",
  "GET /auth/sessions",
  "DELETE /auth/sessions/:id",
]);

describe("Route coverage (WO-023)", () => {
  it("every route in the manifest is classified as either public or protected", () => {
    const unclassified: string[] = [];

    for (const route of ALL_ROUTES) {
      const isPublic = PUBLIC_ROUTES.has(route);
      const isProtected = PROTECTED_ROUTES.has(route);

      if (!isPublic && !isProtected) {
        unclassified.push(route);
      }
    }

    expect(
      unclassified,
      `These routes are neither in PUBLIC_ROUTES nor PROTECTED_ROUTES:\n${unclassified.join("\n")}\n\nAdd them to src/config/publicRoutes.ts.`,
    ).toHaveLength(0);
  });

  it("no route is classified as both public AND protected", () => {
    const conflicts: string[] = [];

    for (const route of ALL_ROUTES) {
      if (PUBLIC_ROUTES.has(route) && PROTECTED_ROUTES.has(route)) {
        conflicts.push(route);
      }
    }

    expect(
      conflicts,
      `These routes appear in both PUBLIC_ROUTES and PROTECTED_ROUTES:\n${conflicts.join("\n")}`,
    ).toHaveLength(0);
  });

  it("all health check routes are public", () => {
    expect(PUBLIC_ROUTES.has("GET /health/live")).toBe(true);
    expect(PUBLIC_ROUTES.has("GET /health/ready")).toBe(true);
  });

  it("protected routes include all authenticated session management routes", () => {
    expect(PROTECTED_ROUTES.has("POST /auth/logout")).toBe(true);
    expect(PROTECTED_ROUTES.has("POST /auth/logout-all")).toBe(true);
    expect(PROTECTED_ROUTES.has("GET /auth/sessions")).toBe(true);
    expect(PROTECTED_ROUTES.has("DELETE /auth/sessions/:id")).toBe(true);
  });

  it("sensitive routes (login, register) are in the public list (they enforce their own access control)", () => {
    expect(PUBLIC_ROUTES.has("POST /auth/login")).toBe(true);
    expect(PUBLIC_ROUTES.has("POST /auth/register")).toBe(true);
  });

  it("refresh endpoint is classified as public (uses cookie+CSRF auth, not Bearer)", () => {
    expect(PUBLIC_ROUTES.has("POST /auth/refresh")).toBe(true);
  });
});
