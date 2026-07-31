/**
 * Unit tests for lib/observability/errorReporter.ts
 *
 * Covers:
 * - buildErrorReport scrubs email, tokens, and card data
 * - scrubString replaces patterns correctly
 * - scrubObject redacts known sensitive keys
 * - reportError sends to the error endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "../../setup.js";
import {
  scrubString,
  scrubObject,
  buildErrorReport,
  reportError,
} from "@/lib/observability/errorReporter";

describe("scrubString", () => {
  it("replaces email addresses with [email]", () => {
    expect(scrubString("Error for user@example.com")).toBe("Error for [email]");
  });

  it("replaces card numbers with [card]", () => {
    expect(scrubString("Card: 4111 1111 1111 1111")).toBe("Card: [card]");
    expect(scrubString("Card: 4111111111111111")).toBe("Card: [card]");
  });

  it("preserves strings without PII", () => {
    expect(scrubString("TypeError: Cannot read property 'x' of null")).toBe(
      "TypeError: Cannot read property 'x' of null",
    );
  });

  it("handles multiple emails in one string", () => {
    const result = scrubString("From: a@test.com To: b@test.com");
    expect(result).not.toContain("a@test.com");
    expect(result).not.toContain("b@test.com");
    expect(result).toContain("[email]");
  });
});

describe("scrubObject", () => {
  it("replaces email key with [redacted]", () => {
    const result = scrubObject({ email: "user@example.com", name: "Jane" });
    expect(result["email"]).toBe("[redacted]");
    expect(result["name"]).toBe("Jane");
  });

  it("replaces token key with [redacted]", () => {
    const result = scrubObject({ token: "eyJhbGciOiJSUzI1NiJ9" });
    expect(result["token"]).toBe("[redacted]");
  });

  it("replaces password key with [redacted]", () => {
    const result = scrubObject({ password: "hunter2" });
    expect(result["password"]).toBe("[redacted]");
  });

  it("replaces cardNumber key with [redacted]", () => {
    const result = scrubObject({ cardNumber: "4111111111111111" });
    expect(result["cardNumber"]).toBe("[redacted]");
  });

  it("scrubs email patterns in non-PII-key string values", () => {
    const result = scrubObject({ message: "User user@example.com triggered error" });
    expect((result["message"] as string)).toContain("[email]");
  });

  it("handles nested objects recursively", () => {
    const result = scrubObject({
      context: { token: "secret", route: "/search" },
    });
    const context = result["context"] as Record<string, unknown>;
    expect(context["token"]).toBe("[redacted]");
    expect(context["route"]).toBe("/search");
  });
});

describe("buildErrorReport", () => {
  it("scrubs message containing email", () => {
    const err = new Error("Failed for user@example.com");
    const report = buildErrorReport(err, { route: "/checkout" });
    expect(report.message).not.toContain("@example.com");
    expect(report.message).toContain("[email]");
  });

  it("includes release tag", () => {
    const err = new Error("test");
    const report = buildErrorReport(err);
    expect(typeof report.release).toBe("string");
  });

  it("includes ISO timestamp", () => {
    const err = new Error("test");
    const report = buildErrorReport(err);
    expect(new Date(report.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("includes route from options", () => {
    const err = new Error("test");
    const report = buildErrorReport(err, { route: "/profile" });
    expect(report.route).toBe("/profile");
  });

  it("scrubs context object", () => {
    const err = new Error("test");
    const report = buildErrorReport(err, {
      route: "/",
      context: { token: "abc", userId: "u123" },
    });
    const ctx = report.context as Record<string, unknown>;
    expect(ctx["token"]).toBe("[redacted]");
    expect(ctx["userId"]).toBe("u123");
  });
});

describe("reportError", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST to the error endpoint", async () => {
    let capturedPayload: unknown = null;

    mswServer.use(
      http.post("/api/observability/errors", async ({ request }) => {
        capturedPayload = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    reportError(new Error("Something went wrong"), { route: "/checkout" });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(capturedPayload).not.toBeNull();
    const payload = capturedPayload as Record<string, unknown>;
    expect(payload["route"]).toBe("/checkout");
    expect(typeof payload["message"]).toBe("string");
    expect(typeof payload["timestamp"]).toBe("string");
  });

  it("does not throw when the endpoint fails", async () => {
    mswServer.use(
      http.post("/api/observability/errors", () => HttpResponse.error()),
    );

    expect(() => reportError(new Error("crash"), { route: "/" })).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
});
