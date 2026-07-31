import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright end-to-end test configuration.
 *
 * - Runs against a locally started Next.js production build
 * - Covers desktop (1280x720) and mobile (375x667) viewports
 * - Uses MSW or seed fixtures to avoid real backend calls
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] !== undefined ? 2 : 0,
  workers: process.env["CI"] !== undefined ? 1 : undefined,
  reporter: process.env["CI"] !== undefined
    ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "html",

  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    // Desktop Chrome
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    // Mobile Safari (iPhone 13)
    {
      name: "mobile-safari",
      use: {
        ...devices["iPhone 13"],
      },
    },
  ],

  // Start the Next.js dev/preview server before tests
  webServer: {
    command: process.env["CI"] !== undefined
      ? "pnpm start"
      : "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:4000/api/v1",
      SESSION_SECRET: process.env["SESSION_SECRET"] ?? "test-session-secret-exactly-32-chars!!",
    },
  },
});
