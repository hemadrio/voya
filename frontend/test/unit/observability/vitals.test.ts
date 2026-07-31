/**
 * Unit tests for lib/observability/vitals.ts
 *
 * Covers:
 * - detectDeviceType() returns expected values based on navigator.userAgent
 * - reportWebVital() sends correct payload via sendBeacon/fetch
 * - makeVitalsHandler() creates a handler that calls reportWebVital
 * - Metric mapping to correct VitalName values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../setup.js";
import {
  detectDeviceType,
  reportWebVital,
  makeVitalsHandler,
  getEffectiveConnectionType,
} from "@/lib/observability/vitals";
import type { VitalMetric } from "@/lib/observability/vitals";

const MOCK_LCP: VitalMetric = {
  name: "LCP",
  value: 1800,
  id: "v3-1234567890",
  rating: "good",
};

const MOCK_CLS: VitalMetric = {
  name: "CLS",
  value: 0.05,
  id: "v3-0987654321",
  rating: "good",
};

const MOCK_INP: VitalMetric = {
  name: "INP",
  value: 120,
  id: "v3-abcdef0123",
  rating: "needs-improvement",
};

describe("detectDeviceType", () => {
  const originalUA = navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () => originalUA,
      configurable: true,
    });
  });

  it("returns 'desktop' for a desktop user agent", () => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      configurable: true,
    });
    expect(detectDeviceType()).toBe("desktop");
  });

  it("returns 'mobile' for a mobile user agent", () => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile/15E148",
      configurable: true,
    });
    expect(detectDeviceType()).toBe("mobile");
  });

  it("returns 'tablet' for an iPad user agent", () => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
    expect(detectDeviceType()).toBe("tablet");
  });
});

describe("reportWebVital", () => {
  beforeEach(() => {
    // Ensure sendBeacon is NOT available so tests use fetch
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST to the vitals endpoint with correct payload", async () => {
    let capturedPayload: unknown = null;

    mswServer.use(
      http.post("/api/analytics/vitals", async ({ request }) => {
        capturedPayload = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    reportWebVital(MOCK_LCP, "/search");

    // Wait for the async fetch to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(capturedPayload).not.toBeNull();
    const payload = capturedPayload as Record<string, unknown>;
    expect(payload["metric"]).toBe("LCP");
    expect(payload["value"]).toBe(1800);
    expect(payload["route"]).toBe("/search");
    expect(payload["rating"]).toBe("good");
    expect(typeof payload["timestamp"]).toBe("string");
  });

  it("includes deviceType in payload", async () => {
    let capturedPayload: unknown = null;

    mswServer.use(
      http.post("/api/analytics/vitals", async ({ request }) => {
        capturedPayload = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    reportWebVital(MOCK_CLS, "/");

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const payload = capturedPayload as Record<string, unknown>;
    expect(["desktop", "mobile", "tablet"]).toContain(payload["deviceType"]);
  });

  it("does not throw on fetch failure", async () => {
    mswServer.use(
      http.post("/api/analytics/vitals", () => HttpResponse.error()),
    );

    expect(() => reportWebVital(MOCK_INP, "/")).not.toThrow();
    // Wait for the async fetch to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
});

describe("makeVitalsHandler", () => {
  it("returns a function that calls reportWebVital with the route", async () => {
    let capturedPayload: unknown = null;

    mswServer.use(
      http.post("/api/analytics/vitals", async ({ request }) => {
        capturedPayload = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const handler = makeVitalsHandler("/search");
    handler(MOCK_LCP);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const payload = capturedPayload as Record<string, unknown>;
    expect(payload?.["route"]).toBe("/search");
    expect(payload?.["metric"]).toBe("LCP");
  });
});
