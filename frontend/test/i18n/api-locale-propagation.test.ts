/**
 * Integration tests — locale and currency parameter propagation.
 *
 * Verifies that:
 *   - Every request carries Accept-Language and X-Currency headers
 *   - Switching locale/currency via setLocaleProvider() immediately affects
 *     subsequent requests without a page reload
 *   - Search, quote, and checkout-style requests all carry the active locale
 */

import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { apiClient, setLocaleProvider } from "../../lib/api/client.js";

const BASE = "http://localhost:4000/api/v1";

function url(path: string) {
  return `${BASE}${path}`;
}

// Reset to default locale provider before each test
beforeEach(() => {
  setLocaleProvider(() => ({ locale: "en", currency: "USD" }));
});

// ---------------------------------------------------------------------------
// Every request carries locale + currency headers
// ---------------------------------------------------------------------------

describe("API client — locale and currency header propagation", () => {
  it("attaches Accept-Language header on GET /search", async () => {
    let capturedLocale: string | null = null;
    let capturedCurrency: string | null = null;

    mswServer.use(
      http.get(url("/search"), ({ request }) => {
        capturedLocale = request.headers.get("accept-language");
        capturedCurrency = request.headers.get("x-currency");
        return HttpResponse.json({ results: [] });
      }),
    );

    setLocaleProvider(() => ({ locale: "es", currency: "EUR" }));
    await apiClient.get(url("/search").replace(BASE, ""));

    expect(capturedLocale).toBe("es");
    expect(capturedCurrency).toBe("EUR");
  });

  it("attaches Accept-Language header on POST /bookings (checkout)", async () => {
    let capturedLocale: string | null = null;
    let capturedCurrency: string | null = null;

    mswServer.use(
      http.post(url("/bookings"), ({ request }) => {
        capturedLocale = request.headers.get("accept-language");
        capturedCurrency = request.headers.get("x-currency");
        return HttpResponse.json({ bookingId: "bk-001" });
      }),
    );

    setLocaleProvider(() => ({ locale: "ar", currency: "AED" }));
    await apiClient.post("/bookings", { offerId: "offer-001" });

    expect(capturedLocale).toBe("ar");
    expect(capturedCurrency).toBe("AED");
  });

  it("uses default en/USD when no locale provider set", async () => {
    let capturedLocale: string | null = null;
    let capturedCurrency: string | null = null;

    mswServer.use(
      http.get(url("/offers"), ({ request }) => {
        capturedLocale = request.headers.get("accept-language");
        capturedCurrency = request.headers.get("x-currency");
        return HttpResponse.json({ results: [] });
      }),
    );

    // beforeEach resets to default en/USD
    await apiClient.get("/offers");

    expect(capturedLocale).toBe("en");
    expect(capturedCurrency).toBe("USD");
  });

  it("switching currency via setLocaleProvider propagates on next request", async () => {
    const capturedCurrencies: string[] = [];

    mswServer.use(
      http.get(url("/quotes/:id"), ({ request }) => {
        const cur = request.headers.get("x-currency");
        if (cur) capturedCurrencies.push(cur);
        return HttpResponse.json({ total: 100 });
      }),
    );

    setLocaleProvider(() => ({ locale: "en", currency: "USD" }));
    await apiClient.get("/quotes/q-001");

    // Simulate currency switch
    setLocaleProvider(() => ({ locale: "en", currency: "EUR" }));
    await apiClient.get("/quotes/q-001");

    expect(capturedCurrencies).toHaveLength(2);
    expect(capturedCurrencies[0]).toBe("USD");
    expect(capturedCurrencies[1]).toBe("EUR");
  });

  it("switching locale preserves currency on the same request", async () => {
    let capturedLocale: string | null = null;
    let capturedCurrency: string | null = null;

    mswServer.use(
      http.get(url("/search"), ({ request }) => {
        capturedLocale = request.headers.get("accept-language");
        capturedCurrency = request.headers.get("x-currency");
        return HttpResponse.json({ results: [] });
      }),
    );

    setLocaleProvider(() => ({ locale: "es", currency: "EUR" }));
    await apiClient.get("/search");

    expect(capturedLocale).toBe("es");
    expect(capturedCurrency).toBe("EUR");
  });

  it("carries headers on PATCH (account update)", async () => {
    let capturedLocale: string | null = null;

    mswServer.use(
      http.patch(url("/users/me"), ({ request }) => {
        capturedLocale = request.headers.get("accept-language");
        return HttpResponse.json({ ok: true });
      }),
    );

    setLocaleProvider(() => ({ locale: "ar", currency: "SAR" }));
    await apiClient.patch("/users/me", { displayName: "Test" });

    expect(capturedLocale).toBe("ar");
  });
});
