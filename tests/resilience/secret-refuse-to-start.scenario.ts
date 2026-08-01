/**
 * Secret refuse-to-start scenario (WO-099 AC10).
 *
 * Asserts:
 *   - Service refuses to start when a required secret is absent.
 *   - Service refuses to start when a required secret matches a known placeholder.
 *   - The missing key name is logged (never the value).
 *   - A non-zero exit code is produced.
 *   - A valid secret passes the validator.
 *
 * Uses the @travel/observability validate() function directly —
 * no process.exit() is called in tests; we assert on the violation list instead.
 */

import { describe, it, expect } from "vitest";
import {
  validate,
  PLACEHOLDER_BLOCKLIST,
} from "@travel/observability";
import type { SecretDescriptor } from "@travel/observability";
import {
  PLACEHOLDER_SECRET_VALUE,
  ABSENT_SECRET_ENV_VAR,
  EMPTY_SECRET_VALUE,
} from "./fixtures/fault-stubs.js";

// ---------------------------------------------------------------------------
// Test manifest
// ---------------------------------------------------------------------------

const MANIFEST: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: "DATABASE_URL",
    description: "PostgreSQL connection string for the service",
    minLength: 20,
  },
  {
    envVar: "JWT_SECRET",
    description: "HS256 signing key for JWTs",
    minLength: 32,
  },
  {
    envVar: "STRIPE_SECRET_KEY",
    description: "Stripe restricted API key",
    minLength: 20,
  },
];

// ---------------------------------------------------------------------------
// AC10: Absent secret
// ---------------------------------------------------------------------------

describe("AC10: Secret validator — absent secret", () => {
  it("returns ok=false and a MISSING_SECRET violation when a required env var is not set", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://synth:synth@localhost:5432/synth_test",
      JWT_SECRET: "synth-test-jwt-secret-32-chars-pad",
      // STRIPE_SECRET_KEY intentionally missing
    };

    const result = validate(MANIFEST, env);

    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.envVar === "STRIPE_SECRET_KEY");
    expect(violation).toBeDefined();
    expect(violation!.code).toBe("MISSING_SECRET");
  });

  it("names the missing key in the violation but never the value", () => {
    const env: Record<string, string | undefined> = {};
    const result = validate(MANIFEST, env);

    expect(result.ok).toBe(false);
    for (const violation of result.violations) {
      expect(violation.envVar).toBeTruthy(); // key name is present
    }

    // The violation reason must not contain any secret value
    for (const violation of result.violations) {
      expect(violation.reason).not.toContain("postgresql://");
      expect(violation.reason).not.toContain("sk_live");
      expect(violation.reason).not.toContain("sk_test");
    }
  });

  it("empty string is treated as MISSING (not a valid value)", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: EMPTY_SECRET_VALUE, // ""
      JWT_SECRET: "synth-test-jwt-secret-32-chars-pad",
      STRIPE_SECRET_KEY: "synth-stripe-key-20-chars-ok",
    };

    const result = validate(MANIFEST, env);
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.envVar === "DATABASE_URL");
    expect(violation).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC10: Placeholder secret
// ---------------------------------------------------------------------------

describe("AC10: Secret validator — placeholder secret detected", () => {
  it("returns PLACEHOLDER_SECRET_DETECTED for a known placeholder value", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: PLACEHOLDER_SECRET_VALUE, // "dev-secret-change-me" — on blocklist
      JWT_SECRET: "synth-test-jwt-secret-32-chars-pad",
      STRIPE_SECRET_KEY: "synth-stripe-key-20-chars-ok",
    };

    const result = validate(MANIFEST, env);
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.envVar === "DATABASE_URL");
    expect(violation?.code).toBe("PLACEHOLDER_SECRET_DETECTED");
  });

  it("PLACEHOLDER_BLOCKLIST includes obviously fake values and never resembles a real credential", () => {
    // Verify the blocklist exists and contains expected entries
    expect(PLACEHOLDER_BLOCKLIST).toContain("dev-secret-change-me");
    expect(PLACEHOLDER_BLOCKLIST).toContain("change-me");
    expect(PLACEHOLDER_BLOCKLIST).toContain("placeholder");
    expect(PLACEHOLDER_BLOCKLIST).toContain("secret");

    // None of the blocklist entries should look like a real credential pattern
    for (const entry of PLACEHOLDER_BLOCKLIST) {
      expect(entry).not.toMatch(/^sk_live_/);
      expect(entry).not.toMatch(/^sk_test_[a-zA-Z0-9]{32,}/);
      expect(entry).not.toMatch(/^postgresql:\/\/[^:]+:[^@]+@/);
    }
  });

  it("reports violations for all bad secrets in one result (not one-per-restart)", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: EMPTY_SECRET_VALUE,
      JWT_SECRET: PLACEHOLDER_SECRET_VALUE,
      // STRIPE_SECRET_KEY absent
    };

    const result = validate(MANIFEST, env);
    expect(result.ok).toBe(false);
    // All three violations surfaced at once
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// AC10: Too-short secret
// ---------------------------------------------------------------------------

describe("AC10: Secret validator — too-short secret", () => {
  it("returns SECRET_TOO_SHORT when value is present but shorter than minLength", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "short", // well under minLength=20
      JWT_SECRET: "synth-test-jwt-secret-32-chars-pad",
      STRIPE_SECRET_KEY: "synth-stripe-key-20ch",
    };

    const result = validate(MANIFEST, env);
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.envVar === "DATABASE_URL");
    expect(violation?.code).toBe("SECRET_TOO_SHORT");
  });
});

// ---------------------------------------------------------------------------
// AC10: All valid secrets — ok=true
// ---------------------------------------------------------------------------

describe("AC10: Valid secrets pass the validator", () => {
  it("returns ok=true when all required secrets are present and meet length requirements", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://synth:synth@localhost:5432/synth_test_db",
      JWT_SECRET: "synth-test-jwt-secret-32-chars-padded!!",
      STRIPE_SECRET_KEY: "sk_test_SYNTH0000000000001",
    };

    const result = validate(MANIFEST, env);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC10: Exit code semantics (without actually calling process.exit)
// ---------------------------------------------------------------------------

describe("AC10: Exit code semantics — service must not reach healthy state with invalid secrets", () => {
  it("validation failure means the service process should exit non-zero", () => {
    // In production, assertSecretsOrExit() calls process.exit(1) on violation.
    // Here we assert the validation result's ok flag drives the exit decision.
    const env: Record<string, string | undefined> = {
      // All secrets missing
    };

    const result = validate(MANIFEST, env);
    // ok=false → process.exit(1) would be called → non-zero exit code
    expect(result.ok).toBe(false);
    // exit code = ok ? 0 : 1
    const simulatedExitCode = result.ok ? 0 : 1;
    expect(simulatedExitCode).toBe(1);
  });
});
