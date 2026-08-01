/**
 * Unit tests for image-tag.ts — WO-084.
 *
 * Covers:
 *   - validateServiceName: valid names, invalid names, edge cases
 *   - validateSha: valid SHAs (7-char, 40-char), invalid SHAs
 *   - isMutableTag: all reserved names, case-insensitivity
 *   - generateTag: happy path, mutable-tag rejection, invalid service, invalid SHA
 */

import { describe, it, expect } from "vitest";
import {
  MUTABLE_TAGS,
  validateServiceName,
  validateSha,
  isMutableTag,
  generateTag,
} from "./image-tag.js";

// ── MUTABLE_TAGS ──────────────────────────────────────────────────────────────

describe("MUTABLE_TAGS", () => {
  it("contains 'latest'", () => {
    expect(MUTABLE_TAGS.has("latest")).toBe(true);
  });

  it("contains 'stable'", () => {
    expect(MUTABLE_TAGS.has("stable")).toBe(true);
  });

  it("contains 'dev'", () => {
    expect(MUTABLE_TAGS.has("dev")).toBe(true);
  });

  it("contains 'canary'", () => {
    expect(MUTABLE_TAGS.has("canary")).toBe(true);
  });

  it("does NOT contain 'auth-service' (valid service name)", () => {
    expect(MUTABLE_TAGS.has("auth-service")).toBe(false);
  });
});

// ── validateServiceName ───────────────────────────────────────────────────────

describe("validateServiceName — valid names", () => {
  it("accepts a single lowercase letter", () => {
    expect(validateServiceName("a")).toBeNull();
  });

  it("accepts a simple name like 'booking'", () => {
    expect(validateServiceName("booking")).toBeNull();
  });

  it("accepts a hyphenated name like 'auth-service'", () => {
    expect(validateServiceName("auth-service")).toBeNull();
  });

  it("accepts a name with numbers like 'service2'", () => {
    expect(validateServiceName("service2")).toBeNull();
  });

  it("accepts 'booking-service' (typical pattern)", () => {
    expect(validateServiceName("booking-service")).toBeNull();
  });
});

describe("validateServiceName — invalid names", () => {
  it("rejects empty string", () => {
    const err = validateServiceName("");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects name with leading whitespace", () => {
    const err = validateServiceName(" auth-service");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects name with trailing whitespace", () => {
    const err = validateServiceName("auth-service ");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects uppercase letters", () => {
    const err = validateServiceName("Auth-Service");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects name starting with a hyphen", () => {
    const err = validateServiceName("-auth");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects name ending with a hyphen", () => {
    const err = validateServiceName("auth-");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects names with underscores", () => {
    const err = validateServiceName("auth_service");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });

  it("rejects names with dots", () => {
    const err = validateServiceName("auth.service");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SERVICE_NAME");
  });
});

// ── validateSha ───────────────────────────────────────────────────────────────

describe("validateSha — valid SHAs", () => {
  it("accepts a 7-character abbreviated SHA", () => {
    expect(validateSha("abc1234")).toBeNull();
  });

  it("accepts a 40-character full SHA", () => {
    expect(validateSha("da39a3ee5e6b4b0d3255bfef95601890afd80709")).toBeNull();
  });

  it("accepts a 12-character SHA (common CI length)", () => {
    expect(validateSha("abc123def456")).toBeNull();
  });
});

describe("validateSha — invalid SHAs", () => {
  it("rejects empty string", () => {
    const err = validateSha("");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SHA");
  });

  it("rejects SHA shorter than 7 characters", () => {
    const err = validateSha("abc12");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SHA");
  });

  it("rejects SHA with uppercase hex", () => {
    const err = validateSha("ABC1234");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SHA");
  });

  it("rejects SHA with non-hex characters", () => {
    const err = validateSha("xyz1234");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SHA");
  });

  it("rejects SHA longer than 40 characters", () => {
    const err = validateSha("a".repeat(41));
    expect(err).not.toBeNull();
    expect(err?.code).toBe("INVALID_SHA");
  });
});

// ── isMutableTag ──────────────────────────────────────────────────────────────

describe("isMutableTag", () => {
  it("returns true for 'latest'", () => {
    expect(isMutableTag("latest")).toBe(true);
  });

  it("returns true for 'LATEST' (case-insensitive)", () => {
    expect(isMutableTag("LATEST")).toBe(true);
  });

  it("returns true for 'Latest' (mixed case)", () => {
    expect(isMutableTag("Latest")).toBe(true);
  });

  it("returns true for 'dev'", () => {
    expect(isMutableTag("dev")).toBe(true);
  });

  it("returns true for 'stable'", () => {
    expect(isMutableTag("stable")).toBe(true);
  });

  it("returns true for 'canary'", () => {
    expect(isMutableTag("canary")).toBe(true);
  });

  it("returns true for 'beta'", () => {
    expect(isMutableTag("beta")).toBe(true);
  });

  it("returns true for 'main'", () => {
    expect(isMutableTag("main")).toBe(true);
  });

  it("returns false for a valid service name 'auth-service'", () => {
    expect(isMutableTag("auth-service")).toBe(false);
  });

  it("returns false for 'booking'", () => {
    expect(isMutableTag("booking")).toBe(false);
  });
});

// ── generateTag ───────────────────────────────────────────────────────────────

describe("generateTag — happy path", () => {
  it("produces service-sha tag pattern", () => {
    const result = generateTag("auth-service", "abc1234");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.tag).toBe("auth-service-abc1234");
  });

  it("preserves service and sha in result", () => {
    const result = generateTag("booking-service", "da39a3e");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.service).toBe("booking-service");
    expect(result.result.sha).toBe("da39a3e");
  });

  it("works with a full 40-char SHA", () => {
    const sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const result = generateTag("flight-service", sha);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.tag).toBe(`flight-service-${sha}`);
  });

  it("works with single-char service name", () => {
    const result = generateTag("a", "abc1234");
    expect(result.ok).toBe(true);
  });
});

describe("generateTag — mutable tag rejection", () => {
  it("rejects 'latest' as service name", () => {
    const result = generateTag("latest", "abc1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MUTABLE_TAG");
  });

  it("rejects 'dev' as service name", () => {
    const result = generateTag("dev", "abc1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MUTABLE_TAG");
  });

  it("rejects 'stable' as service name", () => {
    const result = generateTag("stable", "abc1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MUTABLE_TAG");
  });
});

describe("generateTag — invalid service name", () => {
  it("returns INVALID_SERVICE_NAME for empty service", () => {
    const result = generateTag("", "abc1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_SERVICE_NAME");
  });

  it("returns INVALID_SERVICE_NAME for uppercase service", () => {
    const result = generateTag("AuthService", "abc1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_SERVICE_NAME");
  });
});

describe("generateTag — invalid SHA", () => {
  it("returns INVALID_SHA for empty SHA", () => {
    const result = generateTag("auth-service", "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_SHA");
  });

  it("returns INVALID_SHA for a too-short SHA", () => {
    const result = generateTag("auth-service", "abc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_SHA");
  });

  it("returns INVALID_SHA for uppercase SHA", () => {
    const result = generateTag("auth-service", "ABC1234");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_SHA");
  });
});
