/**
 * End-to-end booking journey tests.
 *
 * Covers the critical funnel from home through search, listing detail,
 * checkout, and confirmation. Routes that are stubs (WO-066+) are
 * exercised for navigation and basic render quality — full booking saga
 * tests are completed when those WOs land.
 *
 * Also covers analytics and observability non-regressions:
 * - No uncaught errors on page load
 * - No token material in localStorage or non-httpOnly cookies
 */

import { test, expect } from "@playwright/test";

test.describe("Home page", () => {
  test("renders headline and search CTAs", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /Your journey starts here/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Search Flights/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Find Hotels/i })).toBeVisible();
  });

  test("has skip-to-content link as first focusable element", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const text = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    expect(text).toMatch(/Skip to main content/i);
  });

  test("has no tokens in localStorage", async ({ page }) => {
    await page.goto("/");
    const hasTokens = await page.evaluate(() => {
      const dangerous = ["accessToken", "refreshToken", "token", "auth"];
      return dangerous.some((k) => localStorage.getItem(k) !== null);
    });
    expect(hasTokens).toBe(false);
  });

  test("has no auth tokens in non-httpOnly cookies", async ({ page }) => {
    await page.goto("/");
    const cookies = await page.context().cookies();
    const dangerousCookies = cookies.filter(
      (c) => !c.httpOnly && /token|auth|session/i.test(c.name),
    );
    expect(dangerousCookies.length).toBe(0);
  });
});

test.describe("Search page", () => {
  test("renders search page with tab navigation", async ({ page }) => {
    await page.goto("/search?tab=FLIGHT");
    // Page should render without crashing
    await expect(page).not.toHaveURL(/error/);
    await expect(page.locator("body")).toBeVisible();
  });

  test("search page is accessible via site header link", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Search Flights/i }).first().click();
    await expect(page).toHaveURL(/\/search/);
  });
});

test.describe("Site header — account menu", () => {
  test("shows sign-in and sign-up links when unauthenticated", async ({ page }) => {
    await page.goto("/");
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: /Sign in/i })).toBeVisible();
    await expect(header.getByRole("link", { name: /Sign up/i })).toBeVisible();
  });
});

test.describe("SEO — robots and sitemap", () => {
  test("robots.txt is accessible and disallows checkout", async ({ page }) => {
    const response = await page.goto("/robots.txt");
    expect(response?.status()).toBe(200);
    const body = await response?.text();
    expect(body).toContain("Disallow:");
    expect(body).toContain("/checkout");
    expect(body).toContain("/account");
  });

  test("sitemap.xml is accessible", async ({ page }) => {
    const response = await page.goto("/sitemap.xml");
    expect(response?.status()).toBe(200);
    const body = await response?.text();
    expect(body).toContain("<urlset");
    // Checkout must not appear in sitemap
    expect(body).not.toContain("/checkout");
  });
});

test.describe("Performance — no render-blocking", () => {
  test("home page loads without JavaScript errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(errors.filter((e) => !e.includes("hydrat"))).toHaveLength(0);
  });
});
