/**
 * Unit tests for funnel pseudonymisation (WO-106 AC4, AC10).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  pseudonymise,
  initPseudonymKey,
  _resetPseudonymKey,
} from "../../src/funnel/pseudonymise.js";

const TEST_KEY = "test-pseudonym-key-32chars-padded!!";
const SUBJECT_A = "00000000-0000-0000-0000-000000000001";
const SUBJECT_B = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  _resetPseudonymKey();
  initPseudonymKey(TEST_KEY);
});

describe("pseudonymise — determinism", () => {
  it("produces the same digest for the same subject + key on repeated calls", () => {
    const d1 = pseudonymise(SUBJECT_A);
    const d2 = pseudonymise(SUBJECT_A);
    expect(d1).toBe(d2);
  });

  it("produces different digests for different subjects with the same key", () => {
    expect(pseudonymise(SUBJECT_A)).not.toBe(pseudonymise(SUBJECT_B));
  });

  it("produces a 64-character hex string", () => {
    const digest = pseudonymise(SUBJECT_A);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pseudonymise — key sensitivity", () => {
  it("a different key produces a different digest for the same subject", () => {
    const d1 = pseudonymise(SUBJECT_A, TEST_KEY);
    const d2 = pseudonymise(SUBJECT_A, "different-key-32chars-padded!!!");
    expect(d1).not.toBe(d2);
  });
});

describe("pseudonymise — non-reversibility (structural check)", () => {
  it("the output does not contain the raw subject id", () => {
    const digest = pseudonymise(SUBJECT_A);
    expect(digest).not.toContain(SUBJECT_A);
  });

  it("the output does not contain the key", () => {
    const digest = pseudonymise(SUBJECT_A);
    expect(digest).not.toContain(TEST_KEY);
  });
});

describe("initPseudonymKey — validation", () => {
  it("throws when called with an empty string", () => {
    _resetPseudonymKey();
    expect(() => initPseudonymKey("")).toThrow();
  });

  it("throws when called with a whitespace-only string", () => {
    _resetPseudonymKey();
    expect(() => initPseudonymKey("   ")).toThrow();
  });
});

describe("pseudonymise — uninitialized key", () => {
  it("throws when the key has not been initialised", () => {
    _resetPseudonymKey();
    expect(() => pseudonymise(SUBJECT_A)).toThrow("FUNNEL_PSEUDONYM_KEY not initialised");
  });
});
