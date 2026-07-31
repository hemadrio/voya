/**
 * Unit tests for derivePurgeAfter functions — all nine categories.
 * Uses buildRetentionConfig() to avoid env var dependencies.
 *
 * Covers AC9: unit tests for derivation functions passing.
 */

import { describe, it, expect } from "vitest";
import {
  deriveAccountIdentityPurgeAfter,
  deriveSessionPurgeAfter,
  deriveOneTimeTokenPurgeAfter,
  deriveBookingPurgeAfter,
  deriveTravelerIdentityPurgeAfter,
  deriveItineraryPurgeAfter,
  derivePreferencePurgeAfter,
  deriveConversationPurgeAfter,
  deriveAuditPurgeAfter,
  buildRetentionConfig,
} from "../src/index.js";

const CONFIG = buildRetentionConfig({
  accountIdentityDays: 30,
  transactionYears: 7,
  identityDocumentDays: 90,
  sessionDays: 7,
  itineraryYears: 7,
  preferenceDays: 365,
  conversationDays: 90,
  auditDays: 365,
});

const D = (iso: string) => new Date(iso);

describe("deriveAccountIdentityPurgeAfter", () => {
  it("returns null when no erasure request (live account)", () => {
    expect(deriveAccountIdentityPurgeAfter(null, CONFIG)).toBeNull();
    expect(deriveAccountIdentityPurgeAfter(undefined, CONFIG)).toBeNull();
  });

  it("returns erasure_requested_at + 30 days", () => {
    const result = deriveAccountIdentityPurgeAfter(D("2025-01-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-01-31T00:00:00.000Z");
  });

  it("edge case: erasure cancelled — null resets purge_after (caller clears the date)", () => {
    // Caller sets erasure_requested_at=null → derive returns null → purge_after cleared
    expect(deriveAccountIdentityPurgeAfter(null, CONFIG)).toBeNull();
  });
});

describe("deriveSessionPurgeAfter", () => {
  it("returns expires_at + 7 days", () => {
    const result = deriveSessionPurgeAfter(D("2025-03-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-03-08T00:00:00.000Z");
  });
});

describe("deriveOneTimeTokenPurgeAfter", () => {
  it("returns expires_at + 7 days (same rule as session)", () => {
    const result = deriveOneTimeTokenPurgeAfter(D("2025-06-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-06-08T00:00:00.000Z");
  });
});

describe("deriveBookingPurgeAfter", () => {
  it("returns created_at + 7 years", () => {
    const result = deriveBookingPurgeAfter(D("2024-05-15T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2031-05-15T00:00:00.000Z");
  });

  it("cancelled booking keeps the same horizon (not shortened)", () => {
    // Caller passes created_at regardless of status — purge_after does not depend on status
    const created = D("2024-01-01T00:00:00Z");
    const result = deriveBookingPurgeAfter(created, CONFIG);
    expect(result?.toISOString()).toBe("2031-01-01T00:00:00.000Z");
  });
});

describe("deriveTravelerIdentityPurgeAfter", () => {
  it("returns null when trip not yet completed (future trip)", () => {
    expect(deriveTravelerIdentityPurgeAfter(null, CONFIG)).toBeNull();
    expect(deriveTravelerIdentityPurgeAfter(undefined, CONFIG)).toBeNull();
  });

  it("returns trip_completed_at + 90 days", () => {
    const result = deriveTravelerIdentityPurgeAfter(D("2025-04-10T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-07-09T00:00:00.000Z");
  });

  it("never defaults to now + 90 days for in-flight trip (null guard)", () => {
    // In-flight = tripCompletedAt not yet set → must return null
    const result = deriveTravelerIdentityPurgeAfter(null, CONFIG);
    expect(result).toBeNull();
  });
});

describe("deriveItineraryPurgeAfter", () => {
  it("returns created_at + 7 years", () => {
    const result = deriveItineraryPurgeAfter(D("2024-08-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2031-08-01T00:00:00.000Z");
  });
});

describe("derivePreferencePurgeAfter", () => {
  it("returns updated_at + 365 days", () => {
    const result = derivePreferencePurgeAfter(D("2024-07-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-07-01T00:00:00.000Z");
  });
});

describe("deriveConversationPurgeAfter", () => {
  it("returns last_message_at + 90 days", () => {
    const result = deriveConversationPurgeAfter(D("2025-01-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-04-01T00:00:00.000Z");
  });
});

describe("deriveAuditPurgeAfter", () => {
  it("returns occurred_at + 365 days (minimum)", () => {
    const result = deriveAuditPurgeAfter(D("2024-01-01T00:00:00Z"), CONFIG);
    expect(result?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });
});
