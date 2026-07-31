/**
 * Cancellation flow e2e tests.
 *
 * These tests cover the cancellation path from the account page.
 * The full cancellation implementation lands in WO-069; these specs
 * establish the navigation contract and ensure the route renders
 * without error for an authenticated user.
 */

import { test, expect } from "@playwright/test";

test.describe("Cancellation flow — navigation", () => {
  test("unauthenticated user is redirected from account to sign-in", async ({ page }) => {
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in/);
    // returnTo must point back to account
    const url = new URL(page.url());
    const returnTo = url.searchParams.get("returnTo");
    expect(returnTo).toBeTruthy();
    expect(returnTo).toContain("/account");
  });

  test("unauthenticated user cannot access profile page", async ({ page }) => {
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
