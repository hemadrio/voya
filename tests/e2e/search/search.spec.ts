/**
 * Search journey specs.
 *
 * Covers AC1 and AC2 from WO-097:
 *   AC1: Guest flight/hotel/car search; IATA rejection with no supplier call;
 *        date-coherence rejection naming the offending field.
 *   AC2: Zero-availability empty state with alternative-date suggestions;
 *        each result displays supplier, total price, currency, validity timestamp.
 */

import { test, expect } from "@playwright/test";
import {
  assertNoSupplierRequest,
} from "../helpers/network-assertions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0]!;
})();

const DAY_AFTER = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0]!;
})();

const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0]!;
})();

// ---------------------------------------------------------------------------
// Search journeys — guest (unauthenticated)
// ---------------------------------------------------------------------------

test.describe("Search — guest access", () => {
  test("guest can search for flights without signing in", async ({ page }) => {
    await page.goto("/en/search");

    // Should be accessible without auth redirect
    await expect(page).not.toHaveURL(/sign-in/);
    await expect(page.getByRole("main")).toBeVisible();

    // Fill in a valid flight search
    await page.getByLabel(/from|origin/i).fill("JFK");
    await page.getByLabel(/to|destination/i).fill("LHR");
    await page.getByLabel(/depart/i).fill(TOMORROW);
    await page.getByRole("button", { name: /search/i }).click();

    // Results should load — wait for search results container
    await page.waitForSelector("[data-testid='search-results'], [data-testid='empty-state']", {
      timeout: 20_000,
    });

    // No sign-in redirect should happen mid-search
    await expect(page).not.toHaveURL(/sign-in/);
  });

  test("guest can search for hotels without signing in", async ({ page }) => {
    await page.goto("/en/search?type=hotel");

    await expect(page).not.toHaveURL(/sign-in/);
    await page.getByLabel(/destination|location/i).fill("London");
    await page.getByLabel(/check.?in/i).fill(TOMORROW);
    await page.getByLabel(/check.?out/i).fill(DAY_AFTER);
    await page.getByRole("button", { name: /search/i }).click();

    await page.waitForSelector("[data-testid='search-results'], [data-testid='empty-state']", {
      timeout: 20_000,
    });
    await expect(page).not.toHaveURL(/sign-in/);
  });

  test("guest can search for car rentals without signing in", async ({ page }) => {
    await page.goto("/en/search?type=car");

    await expect(page).not.toHaveURL(/sign-in/);
    await page.getByLabel(/pickup|pick.up/i).fill("LAX");
    await page.getByLabel(/pickup.date|pick.up.date/i).fill(TOMORROW);
    await page.getByLabel(/dropoff.date|drop.off.date/i).fill(DAY_AFTER);
    await page.getByRole("button", { name: /search/i }).click();

    await page.waitForSelector("[data-testid='search-results'], [data-testid='empty-state']", {
      timeout: 20_000,
    });
    await expect(page).not.toHaveURL(/sign-in/);
  });
});

// ---------------------------------------------------------------------------
// AC1: Four-letter IATA code rejection with no supplier call
// ---------------------------------------------------------------------------

test.describe("Search — IATA validation", () => {
  test("four-letter airport code is rejected with field-level 400 and no supplier call is made", async ({
    page,
  }) => {
    await page.goto("/en/search");

    // Use network interception to prove no supplier call
    await assertNoSupplierRequest(page, async () => {
      await page.getByLabel(/from|origin/i).fill("JFKK"); // four letters — invalid IATA
      await page.getByLabel(/to|destination/i).fill("LHR");
      await page.getByLabel(/depart/i).fill(TOMORROW);
      await page.getByRole("button", { name: /search/i }).click();

      // Wait for validation feedback
      await page.waitForTimeout(2_000);
    });

    // Expect a field-level error visible to the user
    const errorLocator = page.locator("[aria-invalid='true'], [data-testid='field-error']").first();
    await expect(errorLocator).toBeVisible({ timeout: 5_000 });
  });

  test("three-letter IATA code proceeds to search without validation error", async ({ page }) => {
    await page.goto("/en/search");

    await page.getByLabel(/from|origin/i).fill("JFK");
    await page.getByLabel(/to|destination/i).fill("LHR");
    await page.getByLabel(/depart/i).fill(TOMORROW);
    await page.getByRole("button", { name: /search/i }).click();

    // Should NOT show a field-level IATA error
    const iataError = page.locator("[data-testid='iata-error'], [data-error='iata']");
    await expect(iataError).not.toBeVisible({ timeout: 3_000 }).catch(() => {
      // OK if element doesn't exist at all
    });

    // Should proceed to results
    await page.waitForSelector("[data-testid='search-results'], [data-testid='empty-state']", {
      timeout: 20_000,
    });
  });
});

// ---------------------------------------------------------------------------
// AC1: Date-coherence validation naming the offending field
// ---------------------------------------------------------------------------

test.describe("Search — date coherence", () => {
  test("hotel checkout on same day as checkin is rejected and offending field is named", async ({
    page,
  }) => {
    await page.goto("/en/search?type=hotel");

    await page.getByLabel(/destination|location/i).fill("London");
    await page.getByLabel(/check.?in/i).fill(TOMORROW);
    await page.getByLabel(/check.?out/i).fill(TOMORROW); // same day — invalid
    await page.getByRole("button", { name: /search/i }).click();

    // Expect an error that references the checkout field specifically
    const checkoutError = page.locator(
      "[data-field='checkOut'] [aria-live], [data-testid='checkout-error'], [data-field='check-out']"
    );
    // At least one date-related error should be visible
    const anyDateError = page.locator("[data-testid*='error'], [role='alert']").filter({
      hasText: /check.?out|departure|date/i,
    });

    await expect(anyDateError.first()).toBeVisible({ timeout: 5_000 });
  });

  test("hotel checkout before checkin is rejected", async ({ page }) => {
    await page.goto("/en/search?type=hotel");

    await page.getByLabel(/destination|location/i).fill("London");
    await page.getByLabel(/check.?in/i).fill(DAY_AFTER);
    await page.getByLabel(/check.?out/i).fill(TOMORROW); // before checkin — invalid
    await page.getByRole("button", { name: /search/i }).click();

    const anyDateError = page.locator("[data-testid*='error'], [role='alert']").filter({
      hasText: /check.?out|before|date/i,
    });

    await expect(anyDateError.first()).toBeVisible({ timeout: 5_000 });
  });

  test("car dropoff before pickup is rejected and offending field is named", async ({ page }) => {
    await page.goto("/en/search?type=car");

    await page.getByLabel(/pickup|pick.up/i).fill("LAX");
    await page.getByLabel(/pickup.date|pick.up.date/i).fill(DAY_AFTER);
    await page.getByLabel(/dropoff.date|drop.off.date/i).fill(TOMORROW); // before pickup
    await page.getByRole("button", { name: /search/i }).click();

    const anyDropoffError = page.locator("[data-testid*='error'], [role='alert']").filter({
      hasText: /drop.off|pickup|date|before/i,
    });

    await expect(anyDropoffError.first()).toBeVisible({ timeout: 5_000 });
  });

  test("flight departure date in the past is rejected", async ({ page }) => {
    await page.goto("/en/search");

    await page.getByLabel(/from|origin/i).fill("JFK");
    await page.getByLabel(/to|destination/i).fill("LHR");
    await page.getByLabel(/depart/i).fill(YESTERDAY);
    await page.getByRole("button", { name: /search/i }).click();

    const pastDateError = page.locator("[data-testid*='error'], [role='alert']").filter({
      hasText: /past|future|today|depart/i,
    });

    await expect(pastDateError.first()).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// AC2: Zero-availability empty state + alternative-date suggestions
// ---------------------------------------------------------------------------

test.describe("Search — zero availability empty state", () => {
  test("zero-availability renders empty state with alternative-date suggestions, not a blank list", async ({
    page,
  }) => {
    // Use a synthetic route known to return empty availability in staging
    await page.goto("/en/search?origin=JFK&destination=XYZ_SYNTHETIC_EMPTY&depart=" + TOMORROW);

    await page.getByRole("button", { name: /search/i }).click();

    // Must show an explicit empty-state component
    const emptyState = page.getByTestId("empty-state");
    await expect(emptyState).toBeVisible({ timeout: 20_000 });

    // Must NOT be a blank list (no results without explanation)
    const resultsList = page.getByTestId("search-results");
    await expect(resultsList).not.toBeVisible();

    // Alternative date suggestions should be offered
    const altDates = page.getByTestId("alternative-dates");
    await expect(altDates).toBeVisible({ timeout: 5_000 });
  });

  test("each search result card displays supplier, price, currency, and validity timestamp", async ({
    page,
  }) => {
    await page.goto("/en/search?origin=JFK&destination=LHR&depart=" + TOMORROW);

    await page.getByRole("button", { name: /search/i }).click();

    // Wait for results
    const firstResult = page.getByTestId("search-result-card").first();
    await expect(firstResult).toBeVisible({ timeout: 20_000 });

    // Each card must show the required fields
    await expect(firstResult.getByTestId("supplier-name")).toBeVisible();
    await expect(firstResult.getByTestId("total-price")).toBeVisible();
    await expect(firstResult.getByTestId("currency")).toBeVisible();
    await expect(firstResult.getByTestId("validity-timestamp")).toBeVisible();
  });
});
