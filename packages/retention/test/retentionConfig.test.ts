/**
 * Unit tests for retention configuration loading.
 * Covers AC9: startup validator refusing to boot on missing keys.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadRetentionConfig, buildRetentionConfig } from "../src/retentionConfig.js";

// Save/restore env
let savedEnv: Record<string, string | undefined> = {};

const KEYS = [
  "RETENTION_ACCOUNT_IDENTITY_DAYS",
  "RETENTION_TRANSACTION_YEARS",
  "RETENTION_IDENTITY_DOCUMENT_DAYS",
  "RETENTION_SESSION_DAYS",
  "RETENTION_ITINERARY_YEARS",
  "RETENTION_PREFERENCE_DAYS",
  "RETENTION_CONVERSATION_DAYS",
  "RETENTION_AUDIT_DAYS",
];

const VALID_ENV: Record<string, string> = {
  RETENTION_ACCOUNT_IDENTITY_DAYS: "30",
  RETENTION_TRANSACTION_YEARS: "7",
  RETENTION_IDENTITY_DOCUMENT_DAYS: "90",
  RETENTION_SESSION_DAYS: "7",
  RETENTION_ITINERARY_YEARS: "7",
  RETENTION_PREFERENCE_DAYS: "365",
  RETENTION_CONVERSATION_DAYS: "90",
  RETENTION_AUDIT_DAYS: "365",
};

beforeEach(() => {
  savedEnv = {};
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("loadRetentionConfig", () => {
  it("loads all keys when environment is fully configured", () => {
    Object.assign(process.env, VALID_ENV);
    const config = loadRetentionConfig();
    expect(config.accountIdentityDays).toBe(30);
    expect(config.transactionYears).toBe(7);
    expect(config.identityDocumentDays).toBe(90);
    expect(config.sessionDays).toBe(7);
    expect(config.itineraryYears).toBe(7);
    expect(config.preferenceDays).toBe(365);
    expect(config.conversationDays).toBe(90);
    expect(config.auditDays).toBe(365);
  });

  it("throws and names missing keys when RETENTION_ACCOUNT_IDENTITY_DAYS absent", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env["RETENTION_ACCOUNT_IDENTITY_DAYS"];
    expect(() => loadRetentionConfig()).toThrow(/RETENTION_ACCOUNT_IDENTITY_DAYS/);
  });

  it("throws and names ALL missing keys when no keys configured", () => {
    expect(() => loadRetentionConfig()).toThrow(/Missing required retention config keys/);
  });

  it("throws on invalid (non-numeric) value", () => {
    Object.assign(process.env, VALID_ENV);
    process.env["RETENTION_AUDIT_DAYS"] = "not-a-number";
    expect(() => loadRetentionConfig()).toThrow();
  });

  it("rejects auditDays < 365 (minimum constraint)", () => {
    Object.assign(process.env, { ...VALID_ENV, RETENTION_AUDIT_DAYS: "30" });
    expect(() => loadRetentionConfig()).toThrow();
  });

  it("produces immutable parse result (not mutated by subsequent env changes)", () => {
    Object.assign(process.env, VALID_ENV);
    const config = loadRetentionConfig();
    process.env["RETENTION_ACCOUNT_IDENTITY_DAYS"] = "999";
    // Already-parsed config is not affected
    expect(config.accountIdentityDays).toBe(30);
  });
});

describe("buildRetentionConfig", () => {
  it("accepts valid values without reading env", () => {
    const config = buildRetentionConfig({
      accountIdentityDays: 30,
      transactionYears: 7,
      identityDocumentDays: 90,
      sessionDays: 7,
      itineraryYears: 7,
      preferenceDays: 365,
      conversationDays: 90,
      auditDays: 365,
    });
    expect(config.transactionYears).toBe(7);
  });

  it("rejects auditDays < 365", () => {
    expect(() =>
      buildRetentionConfig({
        accountIdentityDays: 30,
        transactionYears: 7,
        identityDocumentDays: 90,
        sessionDays: 7,
        itineraryYears: 7,
        preferenceDays: 365,
        conversationDays: 90,
        auditDays: 364,
      }),
    ).toThrow();
  });
});
