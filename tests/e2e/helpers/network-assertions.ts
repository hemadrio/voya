/**
 * Network assertion helpers.
 *
 * Provide reusable, Playwright route-interception-based helpers to:
 *   - Assert no outbound supplier request was made (negative claim)
 *   - Assert only first-party API gateway endpoints were called
 *   - Assert no card-like payload traversed a platform origin
 *
 * These helpers prove negative claims that cannot be verified through UI
 * inspection alone, satisfying requirements AC1, AC4, and AC7.
 */

import { type Page, type Route } from "@playwright/test";

// ---------------------------------------------------------------------------
// Known supplier URL patterns (must NOT appear in platform-origin calls)
// ---------------------------------------------------------------------------

const SUPPLIER_URL_PATTERNS = [
  /amadeus\.com/i,
  /api\.amadeus/i,
  /rapidapi\.com/i,
  /api\.stripe\.com\/v1\/(payment_methods|cards)/i, // Stripe card data API — not tokenization
];

// Platform origin patterns — requests TO these are expected
const PLATFORM_ORIGINS = [
  /localhost/,
  /travelplatform\.example\.com/,
  /\.travelplatform\./,
];

// Card-like data patterns (PAN, CVV, expiry in POST body)
const CARD_DATA_PATTERNS = [
  /\b4[0-9]{12}(?:[0-9]{3})?\b/, // Visa PAN
  /\b5[1-5][0-9]{14}\b/,          // Mastercard PAN
  /\b3[47][0-9]{13}\b/,            // AmEx PAN
  /\bcvv\b|\bcvc\b|\bcvc2\b/i,
  /\bcard_number\b/i,
  /"number"\s*:\s*"[0-9]{13,19}"/,
];

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  url: string;
  method: string;
  postData: string | null;
}

/**
 * Install a request logger for the duration of fn(), then return all
 * captured requests. Does NOT intercept or modify requests.
 */
export async function captureRequests(
  page: Page,
  fn: () => Promise<void>,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];

  const handler = (req: { url: () => string; method: () => string; postData: () => string | null }) => {
    captured.push({
      url: req.url(),
      method: req.method(),
      postData: req.postData(),
    });
  };

  page.on("request", handler);
  try {
    await fn();
  } finally {
    page.off("request", handler);
  }

  return captured;
}

// ---------------------------------------------------------------------------
// Assertion functions
// ---------------------------------------------------------------------------

/**
 * Assert that no request matching a supplier URL pattern was made during fn().
 * Proves negative: invalid input → no egress to supplier.
 */
export async function assertNoSupplierRequest(
  page: Page,
  fn: () => Promise<void>,
): Promise<void> {
  const requests = await captureRequests(page, fn);

  const supplierRequests = requests.filter((r) =>
    SUPPLIER_URL_PATTERNS.some((pattern) => pattern.test(r.url)),
  );

  if (supplierRequests.length > 0) {
    const urls = supplierRequests.map((r) => `${r.method} ${r.url}`).join("\n  ");
    throw new Error(
      `Expected no supplier requests, but found ${supplierRequests.length}:\n  ${urls}`,
    );
  }
}

/**
 * Assert that all outbound requests during fn() target only first-party
 * platform origins and known safe CDNs (Next.js static assets, etc.).
 * Used for assistant tool-use validation (AC7).
 */
export async function assertOnlyFirstPartyRequests(
  page: Page,
  fn: () => Promise<void>,
): Promise<void> {
  const requests = await captureRequests(page, fn);

  // Filter to only non-static, non-prefetch requests to external origins
  const externalRequests = requests.filter((r) => {
    const isInternal = PLATFORM_ORIGINS.some((p) => p.test(r.url));
    const isNextStatic = r.url.includes("/_next/") || r.url.includes("/__nextjs");
    const isFont = /fonts\.(gstatic|googleapis)\.com/.test(r.url);
    const isBrowserInternal = r.url.startsWith("data:") || r.url.startsWith("blob:");
    return !isInternal && !isNextStatic && !isFont && !isBrowserInternal;
  });

  if (externalRequests.length > 0) {
    const urls = externalRequests.map((r) => `${r.method} ${r.url}`).join("\n  ");
    throw new Error(
      `Expected only first-party requests, but found external requests:\n  ${urls}`,
    );
  }
}

/**
 * Assert no card-like data payload was sent to any platform origin.
 * Used for PCI scope containment assertion (AC4).
 */
export async function assertNoCardDataToplatformOrigin(
  page: Page,
  fn: () => Promise<void>,
): Promise<void> {
  const requests = await captureRequests(page, fn);

  const platformRequests = requests.filter((r) =>
    PLATFORM_ORIGINS.some((p) => p.test(r.url)),
  );

  for (const req of platformRequests) {
    const body = req.postData ?? "";
    const hasCardData = CARD_DATA_PATTERNS.some((pattern) => pattern.test(body));
    if (hasCardData) {
      throw new Error(
        `PCI violation: card-like data found in request to platform origin:\n  ${req.method} ${req.url}\n  Body: ${body.slice(0, 200)}`,
      );
    }
  }
}

/**
 * Block a route and record whether it was attempted.
 * Returns a function that resolves to true if the route was hit.
 */
export function routeBlocker(page: Page, urlPattern: RegExp): {
  wasHit: () => boolean;
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
} {
  let hit = false;

  const handler = async (route: Route) => {
    hit = true;
    await route.abort("blockedbyclient");
  };

  return {
    wasHit: () => hit,
    install: () => page.route(urlPattern, handler),
    uninstall: () => page.unroute(urlPattern, handler),
  };
}
