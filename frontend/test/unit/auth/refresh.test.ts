/**
 * Unit tests for lib/auth/refresh.ts — single-flight token refresh.
 *
 * Verifies that concurrent callers share one in-flight refresh promise so
 * the backend /api/auth/refresh endpoint is called exactly once per expiry.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../setup.js";
import { refreshTokens, _resetInFlight } from "@/lib/auth/refresh";

const REFRESH_URL = "/api/auth/refresh";

beforeEach(() => {
  _resetInFlight();
});

describe("refreshTokens — success", () => {
  it("returns true when the refresh endpoint responds with 200", async () => {
    mswServer.use(
      http.post(REFRESH_URL, () => HttpResponse.json({ ok: true })),
    );

    const result = await refreshTokens();
    expect(result).toBe(true);
  });

  it("returns false when the refresh endpoint responds with 401", async () => {
    mswServer.use(
      http.post(REFRESH_URL, () =>
        HttpResponse.json({ error: "Refresh failed" }, { status: 401 }),
      ),
    );

    const result = await refreshTokens();
    expect(result).toBe(false);
  });

  it("returns false on network failure", async () => {
    mswServer.use(
      http.post(REFRESH_URL, () => HttpResponse.error()),
    );

    const result = await refreshTokens();
    expect(result).toBe(false);
  });
});

describe("refreshTokens — single-flight deduplication", () => {
  it("makes exactly one fetch call when multiple callers invoke it concurrently", async () => {
    let callCount = 0;

    mswServer.use(
      http.post(REFRESH_URL, async () => {
        callCount += 1;
        // Simulate async latency so overlap is guaranteed
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return HttpResponse.json({ ok: true });
      }),
    );

    // Fire 5 concurrent callers
    const results = await Promise.all([
      refreshTokens(),
      refreshTokens(),
      refreshTokens(),
      refreshTokens(),
      refreshTokens(),
    ]);

    // All callers see a successful result
    expect(results.every((r) => r === true)).toBe(true);

    // Backend was called exactly once
    expect(callCount).toBe(1);
  });

  it("resolves the in-flight promise after completion so next call makes a fresh request", async () => {
    let callCount = 0;

    mswServer.use(
      http.post(REFRESH_URL, () => {
        callCount += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    await refreshTokens();
    await refreshTokens();

    // Two sequential calls — each should hit the endpoint once
    expect(callCount).toBe(2);
  });

  it("all concurrent callers get false when refresh fails", async () => {
    mswServer.use(
      http.post(REFRESH_URL, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return HttpResponse.json({ error: "expired" }, { status: 401 });
      }),
    );

    const results = await Promise.all([
      refreshTokens(),
      refreshTokens(),
      refreshTokens(),
    ]);

    expect(results.every((r) => r === false)).toBe(true);
  });
});

describe("_resetInFlight", () => {
  it("allows a fresh call after manual reset", async () => {
    let callCount = 0;

    mswServer.use(
      http.post(REFRESH_URL, () => {
        callCount += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    // Start but don't await — then reset
    const p = refreshTokens();
    _resetInFlight();

    // Second call should be a NEW request, not the same in-flight
    const p2 = refreshTokens();

    await Promise.all([p, p2]);

    // Two distinct requests were made
    expect(callCount).toBe(2);
  });
});
