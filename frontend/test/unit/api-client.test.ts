/**
 * Unit tests for lib/api/client.ts.
 *
 * Uses MSW (via test/setup.ts) to mock HTTP responses at the network
 * boundary — no real network calls are made.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../setup.js";
import { apiClient, ApiError } from "../../lib/api/client.js";
import { ApiErrorCode } from "../../lib/api/errors.js";
import {
  ERROR_400_VALIDATION,
  ERROR_401_UNAUTHORIZED,
  ERROR_500_INTERNAL,
} from "../fixtures/api-errors.js";

const BASE = "http://localhost:4000/api/v1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function url(path: string) {
  return `${BASE}${path}`;
}

// ---------------------------------------------------------------------------
// GET — success
// ---------------------------------------------------------------------------

describe("apiClient.get — success (200)", () => {
  it("returns parsed JSON body on 200", async () => {
    mswServer.use(
      http.get(url("/offers/abc"), () =>
        HttpResponse.json({ id: "abc", title: "Nonstop JFK→LAX" }),
      ),
    );

    const data = await apiClient.get<{ id: string; title: string }>("/offers/abc");
    expect(data.id).toBe("abc");
    expect(data.title).toBe("Nonstop JFK→LAX");
  });

  it("attaches query params to the URL", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get(url("/search"), ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    await apiClient.get("/search", {
      params: { tab: "FLIGHT", origin: "JFK", passengers: 2 },
    });

    expect(capturedUrl).toContain("tab=FLIGHT");
    expect(capturedUrl).toContain("origin=JFK");
    expect(capturedUrl).toContain("passengers=2");
  });

  it("returns undefined for 204 No Content", async () => {
    mswServer.use(
      http.delete(url("/bookings/x"), () => new HttpResponse(null, { status: 204 })),
    );

    const result = await apiClient.delete<undefined>("/bookings/x");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST — success
// ---------------------------------------------------------------------------

describe("apiClient.post — success (201)", () => {
  it("sends JSON body and returns parsed response", async () => {
    mswServer.use(
      http.post(url("/bookings"), async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ bookingId: "bk_001", offerId: body["offerId"] }, { status: 201 });
      }),
    );

    const data = await apiClient.post<{ bookingId: string; offerId: string }>(
      "/bookings",
      { offerId: "offer_001" },
    );
    expect(data.bookingId).toBe("bk_001");
    expect(data.offerId).toBe("offer_001");
  });
});

// ---------------------------------------------------------------------------
// 400 — validation error with fieldErrors
// ---------------------------------------------------------------------------

describe("apiClient — 400 validation error", () => {
  it("throws ApiError with VALIDATION_FAILED code and fieldErrors", async () => {
    mswServer.use(
      http.post(url("/search"), () =>
        HttpResponse.json(ERROR_400_VALIDATION, { status: 400 }),
      ),
    );

    await expect(apiClient.post("/search", {})).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 400 &&
        err.code === ApiErrorCode.VALIDATION_FAILED &&
        err.fieldErrors?.["departureAirport"] === "Must be a valid 3-letter IATA code",
    );
  });
});

// ---------------------------------------------------------------------------
// 401 — unauthorized
// ---------------------------------------------------------------------------

describe("apiClient — 401 unauthorized", () => {
  it("throws ApiError with UNAUTHORIZED code", async () => {
    mswServer.use(
      http.get(url("/profile"), () =>
        HttpResponse.json(ERROR_401_UNAUTHORIZED, { status: 401 }),
      ),
    );

    await expect(apiClient.get("/profile")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 401 &&
        err.code === ApiErrorCode.UNAUTHORIZED,
    );
  });
});

// ---------------------------------------------------------------------------
// 500 — internal server error
// ---------------------------------------------------------------------------

describe("apiClient — 500 internal server error", () => {
  it("throws ApiError with INTERNAL_ERROR code", async () => {
    mswServer.use(
      http.get(url("/offers"), () =>
        HttpResponse.json(ERROR_500_INTERNAL, { status: 500 }),
      ),
    );

    await expect(apiClient.get("/offers")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 500 &&
        err.code === ApiErrorCode.INTERNAL_ERROR,
    );
  });

  it("handles non-JSON HTML error body gracefully", async () => {
    mswServer.use(
      http.get(url("/offers"), () =>
        new HttpResponse("<html><body>Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );

    await expect(apiClient.get("/offers")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError && err.status === 502 && err.code === ApiErrorCode.BAD_GATEWAY,
    );
  });
});

// ---------------------------------------------------------------------------
// Network failure (AbortController)
// ---------------------------------------------------------------------------

describe("apiClient — network failure", () => {
  it("throws ApiError with NETWORK_ERROR code on abort", async () => {
    mswServer.use(
      http.get(url("/slow"), () => {
        // MSW doesn't simulate aborts directly; we use a different approach
        return HttpResponse.error();
      }),
    );

    await expect(apiClient.get("/slow")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError && err.code === ApiErrorCode.NETWORK_ERROR,
    );
  });

  it("throws ApiError with NETWORK_ERROR when aborted via AbortController", async () => {
    const controller = new AbortController();
    mswServer.use(
      http.get(url("/stream"), async () => {
        // Simulate a hanging request
        await new Promise(() => {}); // never resolves
        return HttpResponse.json({});
      }),
    );

    const promise = apiClient.get("/stream", { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError && err.code === ApiErrorCode.NETWORK_ERROR,
    );
  });
});

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

describe("apiClient — auth header injection", () => {
  it("sends Authorization header when token provider returns a token", async () => {
    const { setTokenProvider } = await import("../../lib/api/client.js");
    setTokenProvider(() => "my-test-token");

    let capturedAuth = "";
    mswServer.use(
      http.get(url("/me"), ({ request }) => {
        capturedAuth = request.headers.get("Authorization") ?? "";
        return HttpResponse.json({ userId: "u1" });
      }),
    );

    await apiClient.get("/me");
    expect(capturedAuth).toBe("Bearer my-test-token");

    // Reset
    setTokenProvider(() => null);
  });
});
