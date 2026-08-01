import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWaivers, validateWaiver } from "./waiver-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf8");
}

// Build time well in the future so valid fixtures are never accidentally expired
const FAR_FUTURE = new Date("2099-01-02T12:00:00Z");
// Build time in the present so expired fixtures (2023) are properly expired
const NOW = new Date();

// ---------------------------------------------------------------------------
// validateWaiver
// ---------------------------------------------------------------------------

describe("validateWaiver", () => {
  it("returns valid for a well-formed, non-expired entry", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00001",
        tool: "snyk",
        justification: "No exploit path in our usage.",
        approver: "lead@example.com",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "2099-01-08T00:00:00Z",
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("valid");
  });

  it("returns expired for a waiver whose expires_at is in the past", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2023-99999",
        tool: "grype",
        justification: "Old waiver.",
        approver: "lead@example.com",
        created_at: "2023-06-01T00:00:00Z",
        expires_at: "2023-06-08T00:00:00Z",
      },
      NOW,
    );
    expect(result.status).toBe("expired");
  });

  it("returns malformed when justification is missing", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00002",
        tool: "snyk",
        approver: "lead@example.com",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "2099-01-08T00:00:00Z",
        // justification omitted
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("malformed");
    expect(result.reason).toMatch(/justification/);
  });

  it("returns malformed when expires_at is blank", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00003",
        tool: "snyk",
        justification: "test",
        approver: "lead@example.com",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "",
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("malformed");
    expect(result.reason).toMatch(/expires_at/);
  });

  it("returns malformed when tool is not in allowed list", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00004",
        tool: "unknown-tool" as never,
        justification: "test",
        approver: "lead@example.com",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "2099-06-01T00:00:00Z",
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("malformed");
    expect(result.reason).toMatch(/tool/);
  });

  it("returns missing_approver when approver is blank", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00005",
        tool: "snyk",
        justification: "test",
        approver: "",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "2099-06-01T00:00:00Z",
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("malformed");
  });

  it("returns missing_approver when approver has no @ sign", () => {
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-00006",
        tool: "snyk",
        justification: "test",
        approver: "no-at-sign",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: "2099-06-01T00:00:00Z",
      },
      FAR_FUTURE,
    );
    expect(result.status).toBe("missing_approver");
  });

  it("returns malformed for a non-object entry", () => {
    const result = validateWaiver("not-an-object", FAR_FUTURE);
    expect(result.status).toBe("malformed");
  });

  it("expires a waiver at exactly the build time (boundary)", () => {
    const expiresAt = "2099-01-05T12:00:00Z";
    const buildTimeAtExpiry = new Date(expiresAt);
    const result = validateWaiver(
      {
        finding_id: "CVE-2099-boundary",
        tool: "semgrep",
        justification: "boundary test",
        approver: "lead@example.com",
        created_at: "2099-01-01T00:00:00Z",
        expires_at: expiresAt,
      },
      buildTimeAtExpiry,
    );
    // expires_at <= buildTime must fail
    expect(result.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// checkWaivers — YAML parsing
// ---------------------------------------------------------------------------

describe("checkWaivers", () => {
  it("passes when waivers list is empty", () => {
    const result = checkWaivers("waivers: []", NOW);
    expect(result.passed).toBe(true);
    expect(result.totalWaivers).toBe(0);
  });

  it("passes when waivers key is null", () => {
    const result = checkWaivers("waivers: ~", NOW);
    expect(result.passed).toBe(true);
    expect(result.totalWaivers).toBe(0);
  });

  it("passes for fixture waiver-valid.yaml", () => {
    // Use FAR_FUTURE so 2099 expires_at is valid
    const result = checkWaivers(fixture("waiver-valid.yaml"), FAR_FUTURE);
    expect(result.passed).toBe(true);
    expect(result.totalWaivers).toBe(2);
    expect(result.expiredCount).toBe(0);
    expect(result.invalidCount).toBe(0);
  });

  it("fails for fixture waiver-expired.yaml", () => {
    const result = checkWaivers(fixture("waiver-expired.yaml"), NOW);
    expect(result.passed).toBe(false);
    expect(result.expiredCount).toBeGreaterThan(0);
  });

  it("fails for fixture waiver-missing-approver.yaml", () => {
    // Use FAR_FUTURE so expiry doesn't fire first
    const result = checkWaivers(fixture("waiver-missing-approver.yaml"), FAR_FUTURE);
    expect(result.passed).toBe(false);
    expect(result.invalidCount).toBeGreaterThan(0);
  });

  it("fails for fixture waiver-malformed.yaml (missing justification)", () => {
    const result = checkWaivers(fixture("waiver-malformed.yaml"), FAR_FUTURE);
    expect(result.passed).toBe(false);
    expect(result.invalidCount).toBeGreaterThan(0);
  });

  it("fails on malformed YAML", () => {
    const result = checkWaivers("waivers: [unclosed bracket", NOW);
    expect(result.passed).toBe(false);
    expect(result.validations[0]?.status).toBe("malformed");
  });

  it("reports the correct expired + invalid counts", () => {
    const mixed = `
waivers:
  - finding_id: CVE-expired
    tool: snyk
    justification: expired one
    approver: lead@example.com
    created_at: "2020-01-01T00:00:00Z"
    expires_at: "2020-01-08T00:00:00Z"
  - finding_id: CVE-valid
    tool: semgrep
    justification: valid one
    approver: lead@example.com
    created_at: "2099-01-01T00:00:00Z"
    expires_at: "2099-01-08T00:00:00Z"
`;
    const result = checkWaivers(mixed, FAR_FUTURE);
    expect(result.passed).toBe(false);
    expect(result.totalWaivers).toBe(2);
    expect(result.expiredCount).toBe(1);
    expect(result.invalidCount).toBe(0);
  });
});
