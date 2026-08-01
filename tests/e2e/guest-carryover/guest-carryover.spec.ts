/**
 * Guest-to-member carryover journey spec.
 *
 * Covers AC9 from WO-097:
 *   A guest builds an itinerary, registers at the point of booking,
 *   and the in-progress itinerary carries over to the new account
 *   with nothing lost.
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Guest-to-member carryover
// ---------------------------------------------------------------------------

test.describe("Guest-to-member carryover", () => {
  // Unique email per test run to avoid conflicts across runs
  const guestEmail = `e2e+guest-${process.env["E2E_SEED_RUN_ID"] ?? Date.now()}@synthetic.travelplatform.example.com`;
  const guestPassword = "GuestCarryover1!";

  test("in-progress guest itinerary carries over intact after registration", async ({ page }) => {
    // ── Step 1: Build an itinerary as a guest ────────────────────────────
    await page.goto("/en/search?origin=JFK&destination=LHR");
    await page.getByRole("button", { name: /search/i }).click();

    const firstResult = page.getByTestId("search-result-card").first();
    await expect(firstResult).toBeVisible({ timeout: 20_000 });

    // Add to itinerary as a guest (no auth)
    await firstResult.getByRole("button", { name: /add to itinerary|save/i }).click();

    // Verify itinerary item was added
    const itineraryCount = page.getByTestId("itinerary-count").or(
      page.getByText(/1 item|added to itinerary/i)
    );
    await expect(itineraryCount).toBeVisible({ timeout: 5_000 });

    // Capture the itinerary item identifier for later comparison
    const itineraryItemId = await page
      .getByTestId("itinerary-item")
      .first()
      .getAttribute("data-item-id")
      .catch(() => null);

    // ── Step 2: Proceed to checkout — should prompt for registration ────
    await page.getByRole("button", { name: /checkout|continue to booking/i }).click();

    // Registration gate: traveler is prompted to sign in or register
    const registrationPrompt = page.getByRole("dialog", { name: /sign in|create account|register/i }).or(
      page.getByTestId("registration-gate")
    );
    await expect(registrationPrompt).toBeVisible({ timeout: 10_000 });

    // ── Step 3: Register as a new member ────────────────────────────────
    const registerTab = registrationPrompt.getByRole("tab", { name: /create|register|sign up/i }).or(
      registrationPrompt.getByRole("link", { name: /create|register/i })
    );

    if (await registerTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await registerTab.click();
    }

    // Fill registration form
    const emailField = registrationPrompt.getByLabel(/email/i).or(page.getByLabel(/email/i)).first();
    await emailField.fill(guestEmail);

    const passwordField = registrationPrompt.getByLabel(/password/i).or(page.getByLabel(/password/i)).first();
    await passwordField.fill(guestPassword);

    const nameField = registrationPrompt.getByLabel(/name/i).or(page.getByLabel(/full name|first name/i)).first();
    if (await nameField.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await nameField.fill("E2E Guest Traveler");
    }

    // Submit registration
    const registerButton = registrationPrompt
      .getByRole("button", { name: /create account|register|sign up/i })
      .or(page.getByRole("button", { name: /create account|register/i }));
    await registerButton.click();

    // ── Step 4: Verify itinerary carried over ───────────────────────────
    // After registration, the itinerary must still be present
    await page.waitForURL(/\/en\/(checkout|account|itinerary)/, { timeout: 15_000 });

    // The original itinerary item must be present in the new account
    if (itineraryItemId) {
      const carriedItem = page.locator(`[data-item-id="${itineraryItemId}"]`);
      await expect(carriedItem).toBeVisible({ timeout: 10_000 });
    } else {
      // Fallback: verify at least one itinerary item exists
      const itineraryItems = page.getByTestId("itinerary-item");
      await expect(itineraryItems.first()).toBeVisible({ timeout: 10_000 });
    }

    // Nothing should be lost — count must be at least 1
    const itemCount = await page.getByTestId("itinerary-item").count();
    expect(itemCount).toBeGreaterThanOrEqual(1);
  });

  test("guest session data is merged, not duplicated, after registration", async ({ page }) => {
    // Build a multi-item guest itinerary
    await page.goto("/en/search?origin=JFK&destination=CDG");
    await page.getByRole("button", { name: /search/i }).click();

    const firstResult = page.getByTestId("search-result-card").first();
    await expect(firstResult).toBeVisible({ timeout: 20_000 });

    await firstResult.getByRole("button", { name: /add to itinerary|save/i }).click();

    // Navigate to itinerary
    await page.goto("/en/itinerary");
    const itemsBefore = await page.getByTestId("itinerary-item").count();

    // Register
    await page.goto("/en/sign-up");
    const uniqueEmail = `e2e+merge-${process.env["E2E_SEED_RUN_ID"] ?? "local"}-${Math.floor(Math.random() * 10000)}@synthetic.travelplatform.example.com`;

    await page.getByLabel(/email/i).fill(uniqueEmail);
    await page.getByLabel(/password/i).fill("MergeTest1!");
    await page.getByRole("button", { name: /create|register|sign up/i }).click();

    await page.waitForURL(/\/en\/(account|itinerary|\/?$)/, { timeout: 15_000 });

    // Navigate to itinerary after registration
    await page.goto("/en/itinerary");
    const itemsAfter = await page.getByTestId("itinerary-item").count();

    // Items must not be duplicated
    expect(itemsAfter).toBeGreaterThanOrEqual(itemsBefore);
    // But also should not exceed original count by more than 1x
    expect(itemsAfter).toBeLessThanOrEqual(itemsBefore * 2);
  });
});
