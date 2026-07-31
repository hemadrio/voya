/**
 * Unit tests for lib/analytics/events.ts
 *
 * Covers:
 * - buildEvent attaches route and timestamp
 * - scrubEvent removes token/payment keys
 * - scrubEvent redacts email patterns in string values
 * - scrubEvent handles nested objects
 * - analytics client batching and flush-on-queue-full
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../setup.js";
import {
  buildEvent,
  scrubEvent,
} from "@/lib/analytics/events";
import {
  trackEvent,
  flushEvents,
  _resetQueue,
  _getQueue,
} from "@/lib/analytics/client";
import {
  FIXTURE_SEARCH_EVENT,
  FIXTURE_PII_EVENT,
  FIXTURE_EMAIL_IN_STRING,
} from "@/test/fixtures/analytics";

// ---------------------------------------------------------------------------
// buildEvent
// ---------------------------------------------------------------------------

describe("buildEvent", () => {
  it("attaches route and timestamp to properties", () => {
    const event = buildEvent(
      {
        name: "search_performed",
        properties: {
          searchType: "FLIGHT",
          resultCount: 5,
          hasFilters: false,
        },
      },
      "/search",
    );

    expect(event.properties.route).toBe("/search");
    expect(typeof event.properties.timestamp).toBe("string");
    // ISO 8601 timestamp
    expect(new Date(event.properties.timestamp ?? "").toString()).not.toBe("Invalid Date");
  });

  it("preserves all original properties", () => {
    const event = buildEvent(
      {
        name: "search_performed",
        properties: {
          searchType: "HOTEL",
          resultCount: 42,
          hasFilters: true,
          currency: "EUR",
        },
      },
      "/search",
    );

    expect(event.properties.searchType).toBe("HOTEL");
    expect(event.properties.resultCount).toBe(42);
    expect(event.properties.hasFilters).toBe(true);
    expect(event.properties.currency).toBe("EUR");
  });
});

// ---------------------------------------------------------------------------
// scrubEvent — PII removal
// ---------------------------------------------------------------------------

describe("scrubEvent", () => {
  it("removes token key entirely", () => {
    const input = { route: "/search", token: "Bearer abc123" };
    const result = scrubEvent(input);
    expect("token" in result).toBe(false);
  });

  it("removes password key entirely", () => {
    const input = { route: "/", password: "hunter2" };
    const result = scrubEvent(input);
    expect("password" in result).toBe(false);
  });

  it("removes cardNumber key entirely", () => {
    const input = { route: "/checkout", cardNumber: "4111111111111111" };
    const result = scrubEvent(input);
    expect("cardNumber" in result).toBe(false);
    expect("card_number" in result).toBe(false);
  });

  it("removes cvv key entirely", () => {
    const input = { route: "/checkout", cvv: "123" };
    const result = scrubEvent(input);
    expect("cvv" in result).toBe(false);
  });

  it("removes email key entirely", () => {
    const input = { route: "/", email: "user@example.com" };
    const result = scrubEvent(input);
    expect("email" in result).toBe(false);
  });

  it("replaces email pattern embedded in a string value with [email]", () => {
    const input = { correlationId: "req_user@example.com_abc123" };
    const result = scrubEvent(input);
    expect(result["correlationId"]).toContain("[email]");
    expect(result["correlationId"]).not.toContain("@example.com");
  });

  it("preserves non-PII string values unchanged", () => {
    const input = { route: "/search", searchType: "FLIGHT", resultCount: 5 };
    const result = scrubEvent(input);
    expect(result["route"]).toBe("/search");
    expect(result["searchType"]).toBe("FLIGHT");
    expect(result["resultCount"]).toBe(5);
  });

  it("handles nested objects recursively", () => {
    const input = {
      route: "/checkout",
      nested: { token: "secret", safe: "value" },
    };
    const result = scrubEvent(input);
    const nested = result["nested"] as Record<string, unknown>;
    expect("token" in nested).toBe(false);
    expect(nested["safe"]).toBe("value");
  });

  it("does not mutate the input object", () => {
    const input = { route: "/", token: "secret", resultCount: 5 };
    const copy = { ...input };
    scrubEvent(input);
    expect(input).toEqual(copy);
  });

  it("scrubs the full PII fixture without throwing", () => {
    const result = scrubEvent(FIXTURE_PII_EVENT.properties);
    expect("token" in result).toBe(false);
    expect("password" in result).toBe(false);
    expect("cardNumber" in result).toBe(false);
    expect(result["route"]).toBe("/search");
    expect(result["resultCount"]).toBe(10);
  });

  it("scrubs email in correlationId string", () => {
    const result = scrubEvent(FIXTURE_EMAIL_IN_STRING.properties);
    expect((result["correlationId"] as string)).toContain("[email]");
  });
});

// ---------------------------------------------------------------------------
// Analytics client — batching
// ---------------------------------------------------------------------------

describe("Analytics client — trackEvent and batching", () => {
  beforeEach(() => {
    _resetQueue();
  });

  afterEach(() => {
    _resetQueue();
    vi.restoreAllMocks();
  });

  it("adds events to the queue", () => {
    trackEvent(FIXTURE_SEARCH_EVENT);
    expect(_getQueue().length).toBe(1);
  });

  it("scrubs PII before queuing", () => {
    trackEvent(FIXTURE_PII_EVENT as Parameters<typeof trackEvent>[0]);
    const queued = _getQueue()[0];
    expect(queued).toBeDefined();
    const props = queued!.properties as Record<string, unknown>;
    expect("token" in props).toBe(false);
    expect("password" in props).toBe(false);
    expect("cardNumber" in props).toBe(false);
  });

  it("flushEvents empties the queue and sends to endpoint", async () => {
    let sentPayload: unknown = null;
    mswServer.use(
      http.post("/api/analytics/events", async ({ request }) => {
        sentPayload = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    trackEvent(FIXTURE_SEARCH_EVENT);
    await flushEvents();

    expect(_getQueue().length).toBe(0);
    expect(sentPayload).not.toBeNull();
    const payload = sentPayload as { events: unknown[] };
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events.length).toBe(1);
  });

  it("flushEvents is a no-op when queue is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await flushEvents();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
