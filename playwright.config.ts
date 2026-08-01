/**
 * Playwright end-to-end configuration — staging journey suites.
 *
 * Runs against a deployed staging environment through the governed API gateway.
 * All specs use synthetic data seeded via tools/seed-synthetic.
 *
 * Environment:
 *   PLAYWRIGHT_BASE_URL  - staging frontend URL (required in CI)
 *   PLAYWRIGHT_API_URL   - staging API gateway URL (required in CI)
 *   E2E_SEED_RUN_ID      - unique run namespace to isolate parallel runs
 *
 * Projects:
 *   search         - guest and authenticated search journeys
 *   checkout       - stale-price, webhook-driven confirmation, expiry
 *   cancellation   - permitted/disallowed transitions, refund routing
 *   assistant      - first-party tools, illustrative guardrails, cost ceiling
 *   guest-carryover - in-progress itinerary survives registration
 *   accessibility  - axe-core WCAG 2.2 AA + keyboard traversal
 */

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,        // staging is shared; serialise to avoid data races
  forbidOnly: !!process.env["CI"],
  retries: 0,                  // negative assertions must never retry into a false pass
  workers: process.env["CI"] !== undefined ? 2 : undefined,

  reporter: process.env["CI"] !== undefined
    ? [
        ["github"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["junit", { outputFile: "playwright-report/results.xml" }],
      ]
    : "html",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: {
      "x-e2e-run": process.env["E2E_SEED_RUN_ID"] ?? "local",
    },
  },

  projects: [
    // ── Shared setup: create authenticated storage state ─────────────────
    {
      name: "setup",
      testMatch: "**/fixtures/auth.setup.ts",
    },

    // ── Search journey ────────────────────────────────────────────────────
    {
      name: "search",
      testMatch: "**/search/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },

    // ── Checkout journey ──────────────────────────────────────────────────
    {
      name: "checkout",
      testMatch: "**/checkout/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/fixtures/.auth/user.json",
      },
      dependencies: ["setup"],
    },

    // ── Cancellation journey ──────────────────────────────────────────────
    {
      name: "cancellation",
      testMatch: "**/cancellation/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/fixtures/.auth/user.json",
      },
      dependencies: ["setup"],
    },

    // ── Assistant journey ─────────────────────────────────────────────────
    {
      name: "assistant",
      testMatch: "**/assistant/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },

    // ── Guest-to-member carryover ─────────────────────────────────────────
    {
      name: "guest-carryover",
      testMatch: "**/guest-carryover/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Accessibility ─────────────────────────────────────────────────────
    {
      name: "accessibility",
      testMatch: "**/accessibility/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
