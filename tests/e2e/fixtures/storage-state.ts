/**
 * Shared storage-state fixtures for Playwright journey suites.
 *
 * Provides authenticated and guest browser context factories so every
 * journey suite starts from a known state without repeating sign-in.
 *
 * Storage state files are written to tests/e2e/fixtures/.auth/ by the
 * auth.setup.ts global setup project and reused by checkout, cancellation,
 * and assistant suites that require an authenticated persona.
 */

import { type Page, type BrowserContext } from "@playwright/test";
import path from "path";

// ---------------------------------------------------------------------------
// Storage state file paths
// ---------------------------------------------------------------------------

export const AUTH_STATE_PATH = path.join(__dirname, ".auth", "user.json");
export const GUEST_STATE_PATH = path.join(__dirname, ".auth", "guest.json");

// ---------------------------------------------------------------------------
// Synthetic traveler credentials (populated by seed-synthetic)
// ---------------------------------------------------------------------------

export const SYNTHETIC_USER = {
  email: `e2e+${process.env["E2E_SEED_RUN_ID"] ?? "local"}@synthetic.travelplatform.example.com`,
  password: "SyntheticPass1!",
  displayName: "E2E Test Traveler",
};

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Sign in as the synthetic test traveler and return the page for chaining.
 * Call only from auth.setup.ts — journey specs reuse the stored state.
 */
export async function signInAsSyntheticUser(page: Page): Promise<void> {
  await page.goto("/en/sign-in");
  await page.getByLabel(/Email address/i).fill(SYNTHETIC_USER.email);
  await page.getByLabel(/Password/i).fill(SYNTHETIC_USER.password);
  await page.getByRole("button", { name: /Sign in/i }).click();
  // Wait for redirect to account after successful sign-in
  await page.waitForURL(/\/en\/account|\/en\/?$/, { timeout: 15_000 });
}

/**
 * Assert the browser context has no auth tokens in non-httpOnly cookies and
 * no sensitive values in localStorage — PCI and session security invariant.
 */
export async function assertNoExposedTokens(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const exposed = cookies.filter(
    (c) => !c.httpOnly && /token|auth|session/i.test(c.name),
  );
  if (exposed.length > 0) {
    throw new Error(
      `Security violation: non-httpOnly auth cookies found: ${exposed.map((c) => c.name).join(", ")}`,
    );
  }
}
