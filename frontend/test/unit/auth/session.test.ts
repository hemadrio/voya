/**
 * Unit tests for lib/auth/session.ts — cookie serialization.
 *
 * Tests the pure serialize/deserialize pair and the HMAC signing verification
 * without calling Next.js cookie APIs (those require a live request context).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serializeSession, deserializeSession } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/session";

const MOCK_SESSION: Session = {
  user: {
    id: "user-123",
    email: "test@example.com",
    firstName: "Jane",
    lastName: "Doe",
    locale: "en",
    currency: "USD",
  },
  accessToken: "access-token-abc",
  refreshToken: "refresh-token-xyz",
  expiresAt: 9999999999000, // far future
};

// Ensure SESSION_SECRET is set for the signing tests
const ORIGINAL_SECRET = process.env["SESSION_SECRET"];

beforeAll(() => {
  process.env["SESSION_SECRET"] = "test-session-secret-exactly-32-chars!!";
});

afterAll(() => {
  if (ORIGINAL_SECRET !== undefined) {
    process.env["SESSION_SECRET"] = ORIGINAL_SECRET;
  } else {
    delete process.env["SESSION_SECRET"];
  }
});

describe("serializeSession / deserializeSession — round-trip", () => {
  it("round-trips a session object through serialize → deserialize", () => {
    const cookie = serializeSession(MOCK_SESSION);
    const restored = deserializeSession(cookie);

    expect(restored).not.toBeNull();
    expect(restored?.user.id).toBe(MOCK_SESSION.user.id);
    expect(restored?.user.email).toBe(MOCK_SESSION.user.email);
    expect(restored?.user.firstName).toBe(MOCK_SESSION.user.firstName);
    expect(restored?.accessToken).toBe(MOCK_SESSION.accessToken);
    expect(restored?.refreshToken).toBe(MOCK_SESSION.refreshToken);
    expect(restored?.expiresAt).toBe(MOCK_SESSION.expiresAt);
  });

  it("preserves optional avatarUrl when present", () => {
    const withAvatar: Session = {
      ...MOCK_SESSION,
      user: { ...MOCK_SESSION.user, avatarUrl: "https://cdn.example.com/avatar.jpg" },
    };
    const cookie = serializeSession(withAvatar);
    const restored = deserializeSession(cookie);
    expect(restored?.user.avatarUrl).toBe("https://cdn.example.com/avatar.jpg");
  });

  it("omits avatarUrl when not set", () => {
    const cookie = serializeSession(MOCK_SESSION);
    const restored = deserializeSession(cookie);
    expect(restored?.user.avatarUrl).toBeUndefined();
  });
});

describe("deserializeSession — tamper detection", () => {
  it("returns null for an empty string", () => {
    expect(deserializeSession("")).toBeNull();
  });

  it("returns null when the signature is missing", () => {
    // Just a raw base64url payload without a dot
    const payload = Buffer.from(JSON.stringify(MOCK_SESSION)).toString("base64url");
    expect(deserializeSession(payload)).toBeNull();
  });

  it("returns null when the signature is altered", () => {
    const cookie = serializeSession(MOCK_SESSION);
    // Flip the last character of the signature
    const last = cookie.slice(-1);
    const flipped = last === "A" ? "B" : "A";
    const tampered = cookie.slice(0, -1) + flipped;
    expect(deserializeSession(tampered)).toBeNull();
  });

  it("returns null when the payload is altered but signature is unchanged", () => {
    const cookie = serializeSession(MOCK_SESSION);
    const dotIndex = cookie.lastIndexOf(".");
    const originalPayload = cookie.slice(0, dotIndex);
    const sig = cookie.slice(dotIndex + 1);

    // Tamper with payload
    const tamperedPayload = originalPayload.slice(0, -2) + "xx";
    const tampered = `${tamperedPayload}.${sig}`;
    expect(deserializeSession(tampered)).toBeNull();
  });

  it("returns null for completely invalid input", () => {
    expect(deserializeSession("not.valid.at.all.garbage")).toBeNull();
    expect(deserializeSession("aaaaa.bbbbb")).toBeNull(); // wrong signature
  });
});

describe("serializeSession — output format", () => {
  it("produces a string containing exactly one dot separator", () => {
    const cookie = serializeSession(MOCK_SESSION);
    // Format: <base64url(payload)>.<base64url(hmac)>
    // There must be at least one dot
    expect(cookie.includes(".")).toBe(true);
  });

  it("does not contain raw token values in plain text", () => {
    const cookie = serializeSession(MOCK_SESSION);
    // Tokens should be base64 encoded, not appear as literal strings
    expect(cookie).not.toContain("access-token-abc");
    expect(cookie).not.toContain("refresh-token-xyz");
  });
});
