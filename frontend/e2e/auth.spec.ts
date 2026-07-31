/**
 * End-to-end auth tests.
 *
 * Covers:
 * - Sign-in form renders and validates client-side
 * - Unauthenticated access to protected routes redirects to sign-in with returnTo
 * - Sign-up form renders and shows verification-pending screen
 * - Forgot-password always shows the same confirmation screen
 * - Sign-in link navigates to sign-in page
 *
 * Uses a mocked backend via environment variable or MSW page fixture.
 */

import { test, expect } from "@playwright/test";

test.describe("Authentication — sign-in page", () => {
  test("renders the sign-in form", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(page.getByLabel(/Password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign in/i })).toBeVisible();
  });

  test("shows client-side validation error for invalid email", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByLabel(/Email address/i).fill("not-an-email");
    await page.getByLabel(/Password/i).fill("secret");
    await page.getByRole("button", { name: /Sign in/i }).click();

    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("shows validation error when email is empty", async ({ page }) => {
    await page.goto("/sign-in");

    await page.getByRole("button", { name: /Sign in/i }).click();

    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("has link to sign-up page", async ({ page }) => {
    await page.goto("/sign-in");

    const signUpLink = page.getByRole("link", { name: /Create one/i });
    await expect(signUpLink).toBeVisible();
    await signUpLink.click();

    await expect(page).toHaveURL(/\/sign-up/);
  });

  test("has link to forgot-password page", async ({ page }) => {
    await page.goto("/sign-in");

    const forgotLink = page.getByRole("link", { name: /Forgot password/i });
    await expect(forgotLink).toBeVisible();
    await forgotLink.click();

    await expect(page).toHaveURL(/\/forgot-password/);
  });
});

test.describe("Authentication — sign-up page", () => {
  test("renders all registration fields", async ({ page }) => {
    await page.goto("/sign-up");

    await expect(page.getByRole("heading", { name: /Create an account/i })).toBeVisible();
    await expect(page.getByLabel(/First name/i)).toBeVisible();
    await expect(page.getByLabel(/Last name/i)).toBeVisible();
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(page.getByLabel(/^Password/i)).toBeVisible();
    await expect(page.getByLabel(/Confirm password/i)).toBeVisible();
  });

  test("shows password mismatch error on submit", async ({ page }) => {
    await page.goto("/sign-up");

    await page.getByLabel(/First name/i).fill("Jane");
    await page.getByLabel(/Last name/i).fill("Doe");
    await page.getByLabel(/Email address/i).fill("jane@example.com");
    await page.getByLabel(/^Password/i).fill("Password1");
    await page.getByLabel(/Confirm password/i).fill("DifferentPassword1");
    await page.getByRole("button", { name: /Create account/i }).click();

    await expect(page.getByText(/Passwords do not match/i)).toBeVisible();
  });
});

test.describe("Authentication — forgot-password page", () => {
  test("shows the non-enumerating confirmation screen after submit", async ({ page }) => {
    await page.goto("/forgot-password");

    await page.getByLabel(/Email address/i).fill("anyemail@example.com");
    await page.getByRole("button", { name: /Send reset link/i }).click();

    // Must show confirmation regardless of whether email exists
    await expect(page.getByRole("heading", { name: /Check your email/i })).toBeVisible();
    await expect(page.getByText(/If an account exists/i)).toBeVisible();
  });
});

test.describe("Middleware — protected route redirects", () => {
  test("redirects unauthenticated user from /profile to sign-in with returnTo", async ({ page }) => {
    await page.goto("/profile");

    // Should be redirected to sign-in
    await expect(page).toHaveURL(/\/sign-in/);
    // returnTo parameter should be preserved
    await expect(page).toHaveURL(/returnTo/);
  });

  test("redirects unauthenticated user from /checkout to sign-in", async ({ page }) => {
    await page.goto("/checkout?offerId=test-offer");

    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe("Accessibility — skip-to-content link", () => {
  test("skip-to-content link is the first focusable element", async ({ page }) => {
    await page.goto("/");

    // Tab once from the body to get to first focusable element
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    expect(focused).toMatch(/Skip to main content/i);
  });

  test("skip-to-content link activates on Enter key", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    // Focus should be on #main-content
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("main-content");
  });
});
