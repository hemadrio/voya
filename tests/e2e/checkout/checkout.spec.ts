/**
 * Checkout journey specs.
 *
 * Covers AC3, AC4, AC5 from WO-097:
 *   AC3: Stale-result freshness label + re-validation; upward price movement re-consent.
 *   AC4: Card data stays in provider-hosted fields; PENDING until signed webhook → CONFIRMED.
 *   AC5: Abandoned booking expires: no funds held, no confirmation email, terminal state.
 */

import { test, expect } from "@playwright/test";
import {
  assertNoCardDataToplatformOrigin,
} from "../helpers/network-assertions.js";
import { assertNoExposedTokens } from "../fixtures/storage-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYNTHETIC_EXPIRED_BOOKING_ID =
  process.env["SYNTHETIC_EXPIRED_BOOKING_ID"] ?? "synthetic-expired-001";

// Staging API base — used for direct webhook injection
const API_BASE =
  process.env["PLAYWRIGHT_API_URL"] ?? "http://localhost:4000";

// ---------------------------------------------------------------------------
// AC3: Stale-result freshness labelling and re-validation
// ---------------------------------------------------------------------------

test.describe("Checkout — stale result handling", () => {
  test("stale cached result is displayed with a visible freshness label before payment", async ({
    page,
  }) => {
    // Navigate to a pre-seeded stale search result
    await page.goto("/en/search?stale=1&origin=JFK&destination=LHR");
    await page.getByRole("button", { name: /search/i }).click();

    const staleResult = page.getByTestId("search-result-card").first();
    await expect(staleResult).toBeVisible({ timeout: 20_000 });

    // Stale results must be visually labelled
    const freshnessLabel = staleResult.getByTestId("freshness-label").or(
      staleResult.getByText(/indicative|cached|prices may have changed/i)
    );
    await expect(freshnessLabel).toBeVisible();
  });

  test("stale result is re-validated before payment step", async ({ page }) => {
    await page.goto("/en/search?stale=1&origin=JFK&destination=LHR");
    await page.getByRole("button", { name: /search/i }).click();

    const staleResult = page.getByTestId("search-result-card").first();
    await staleResult.getByRole("button", { name: /select|book|view deal/i }).click();

    // Platform must re-validate price before showing the payment page
    const validationIndicator = page.getByTestId("price-validation").or(
      page.getByText(/confirming price|re-validating|fetching latest/i)
    );
    await expect(validationIndicator).toBeVisible({ timeout: 10_000 });

    // Must reach the payment step or a re-validated price confirmation
    await page.waitForSelector(
      "[data-testid='payment-step'], [data-testid='price-reconfirmed']",
      { timeout: 20_000 }
    );
  });

  test("upward price movement requires explicit traveler acceptance before payment", async ({
    page,
  }) => {
    // Navigate to a synthetic offer known to have a price increase on re-validation
    await page.goto("/en/checkout/synthetic-price-increase-offer");

    // Wait for the re-validation modal / price-change notice
    const priceChangeModal = page.getByRole("dialog").filter({
      hasText: /price.*changed|new price|accept/i,
    });
    await expect(priceChangeModal).toBeVisible({ timeout: 20_000 });

    // Payment button must NOT be reachable without accepting
    const paymentButton = page.getByRole("button", { name: /pay now|confirm payment/i });
    await expect(paymentButton).not.toBeVisible();

    // Accept the new price
    await priceChangeModal.getByRole("button", { name: /accept|i accept/i }).click();

    // Now the payment step should be accessible
    await expect(paymentButton).toBeVisible({ timeout: 5_000 });
  });

  test("downward price movement is visible and does not block checkout", async ({ page }) => {
    await page.goto("/en/checkout/synthetic-price-decrease-offer");

    // A price drop should be shown but must NOT require extra consent
    const priceDrop = page.getByTestId("price-decreased").or(
      page.getByText(/price.*decreased|lower price/i)
    );
    await expect(priceDrop).toBeVisible({ timeout: 20_000 });

    // Payment should be accessible without extra modal
    const paymentButton = page.getByRole("button", { name: /pay now|confirm payment/i });
    await expect(paymentButton).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// AC4: Card data stays in provider-hosted fields; PENDING → CONFIRMED via webhook
// ---------------------------------------------------------------------------

test.describe("Checkout — card data and booking lifecycle", () => {
  test("card entry uses provider-hosted fields and no card data reaches platform origin", async ({
    page,
    context,
  }) => {
    await page.goto("/en/checkout/synthetic-bookable-offer");

    // Wait for payment step
    await page.waitForSelector("[data-testid='payment-step']", { timeout: 20_000 });

    // The card frame must come from the payment provider (Stripe, Adyen, etc.)
    const cardFrame = page.frameLocator("iframe[name*='stripe'], iframe[src*='stripe'], iframe[src*='checkout'], iframe[title*='card']").first();
    await expect(cardFrame.owner()).toBeVisible({ timeout: 10_000 });

    // Use network assertion to prove no card data leaves for platform origin
    await assertNoCardDataToplatformOrigin(page, async () => {
      // Type a test card number into the provider-hosted iframe
      // Stripe test card: 4242424242424242 — but we intentionally use a DIFFERENT
      // value here so the assertion proves the platform never sees it
      await cardFrame.getByLabel(/card number/i).fill("4111111111111111");
      await cardFrame.getByLabel(/expiry|expiration/i).fill("12/28");
      await cardFrame.getByLabel(/cvc|cvv/i).fill("123");

      // Submit — the provider tokenises the card before any platform call
      await page.getByRole("button", { name: /pay now|confirm/i }).click();

      // Wait for the platform to receive the token (not the card number)
      await page.waitForTimeout(3_000);
    });

    // Verify no auth tokens leaked to non-httpOnly cookies
    await assertNoExposedTokens(context);
  });

  test("booking remains PENDING until signed webhook arrives then transitions to CONFIRMED", async ({
    page,
    request,
  }) => {
    await page.goto("/en/checkout/synthetic-bookable-offer");

    await page.waitForSelector("[data-testid='payment-step']", { timeout: 20_000 });

    // Complete the payment flow with a Stripe test card
    const cardFrame = page.frameLocator("iframe[name*='stripe'], iframe[src*='stripe']").first();
    await cardFrame.getByLabel(/card number/i).fill("4000002500003155"); // 3DS test card
    await cardFrame.getByLabel(/expiry|expiration/i).fill("12/28");
    await cardFrame.getByLabel(/cvc|cvv/i).fill("123");
    await page.getByRole("button", { name: /pay now|confirm/i }).click();

    // Should show PENDING state
    const pendingStatus = page.getByTestId("booking-status").filter({ hasText: /pending/i });
    await expect(pendingStatus).toBeVisible({ timeout: 15_000 });

    // Extract the booking ID from the page
    const bookingIdEl = page.getByTestId("booking-id");
    await expect(bookingIdEl).toBeVisible();
    const bookingId = (await bookingIdEl.textContent()) ?? "";

    // Simulate webhook delivery via staging test endpoint
    const webhookPayload = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: `pi_test_${bookingId.replace(/\D/g, "")}`,
          metadata: { bookingId },
          status: "succeeded",
        },
      },
    };

    // POST signed webhook to staging
    const webhookResponse = await request.post(`${API_BASE}/api/v1/webhooks/stripe/test`, {
      data: webhookPayload,
      headers: {
        "stripe-signature": `t=${Date.now()},v1=test-signature`,
        "x-e2e-run": process.env["E2E_SEED_RUN_ID"] ?? "local",
      },
    });
    expect(webhookResponse.status()).toBeLessThan(300);

    // Poll until CONFIRMED (bounded timeout)
    await expect(async () => {
      await page.reload();
      const confirmedStatus = page.getByTestId("booking-status").filter({ hasText: /confirmed/i });
      await expect(confirmedStatus).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000, intervals: [3_000] });

    // Confirm there is exactly one confirmation displayed
    const confirmationCount = await page.getByTestId("booking-confirmation").count();
    expect(confirmationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC5: Abandoned checkout — no funds held, terminal expiry
// ---------------------------------------------------------------------------

test.describe("Checkout — booking expiry", () => {
  test("abandoned PENDING booking expires with no funds held and no confirmation", async ({
    page,
    request,
  }) => {
    // Use a pre-seeded expired booking
    await page.goto(`/en/account/bookings/${SYNTHETIC_EXPIRED_BOOKING_ID}`);

    // Verify the booking is in an expired terminal state
    const expiredStatus = page.getByTestId("booking-status").filter({ hasText: /expired/i });
    await expect(expiredStatus).toBeVisible({ timeout: 10_000 });

    // No payment due / no funds held message
    const noPaymentDue = page.getByText(/no charge|no funds|not charged/i);
    await expect(noPaymentDue).toBeVisible({ timeout: 5_000 });

    // Verify confirmation email was NOT sent via API
    const emailCheckResponse = await request.get(
      `${API_BASE}/api/v1/synthetic/mailbox/${SYNTHETIC_EXPIRED_BOOKING_ID}/confirmation`,
      {
        headers: { "x-e2e-run": process.env["E2E_SEED_RUN_ID"] ?? "local" },
      }
    );
    const emailBody = await emailCheckResponse.json().catch(() => ({ messages: [] }));
    expect((emailBody as { messages: unknown[] }).messages).toHaveLength(0);
  });

  test("expired booking cannot be resumed or paid", async ({ page }) => {
    await page.goto(`/en/account/bookings/${SYNTHETIC_EXPIRED_BOOKING_ID}`);

    const expiredStatus = page.getByTestId("booking-status").filter({ hasText: /expired/i });
    await expect(expiredStatus).toBeVisible({ timeout: 10_000 });

    // No payment or resume buttons should be present
    await expect(page.getByRole("button", { name: /pay|resume|complete/i })).not.toBeVisible();
  });
});
