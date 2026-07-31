/**
 * Pattern-scan safety test — asserts that no realistic PII patterns appear in
 * any fixture or seed dataset value.
 *
 * Patterns checked:
 *   - Passport numbers: [A-Z]{1,2}[0-9]{6,9} (common formats)
 *   - Payment card numbers: 13–19 consecutive digits
 *   - UK National Insurance Number: [A-Z]{2}[0-9]{6}[A-Z]
 *   - US Social Security Number: \d{3}-\d{2}-\d{4}
 *
 * The test also deliberately introduces a realistic-looking value to confirm
 * the scanner itself works (self-validation).
 */

import { describe, it, expect } from "vitest";
import * as fixtures from "../src/index.js";

// ---------------------------------------------------------------------------
// Patterns for realistic sensitive data
// ---------------------------------------------------------------------------

/** UK/many-country passport: 1-2 uppercase letters followed by 6-9 digits. */
const PASSPORT_PATTERN = /\b[A-Z]{1,2}[0-9]{6,9}\b/;

/** Luhn-ish card number: 13–19 consecutive digits not preceded/followed by digit. */
const CARD_NUMBER_PATTERN = /(?<!\d)\d{13,19}(?!\d)/;

/** US SSN: NNN-NN-NNNN */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

/** UK NINO: two letters, six digits, one letter */
const NINO_PATTERN = /\b[A-Z]{2}[0-9]{6}[A-Z]\b/;

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "passport", re: PASSPORT_PATTERN },
  { name: "card-number", re: CARD_NUMBER_PATTERN },
  { name: "US-SSN", re: SSN_PATTERN },
  { name: "UK-NINO", re: NINO_PATTERN },
];

function scanForPII(value: string): { pattern: string; match: string }[] {
  const found: { pattern: string; match: string }[] = [];
  for (const { name, re } of PATTERNS) {
    const m = re.exec(value);
    if (m !== null) {
      found.push({ pattern: name, match: m[0] });
    }
  }
  return found;
}

// Serialize every exported value to a flat string for pattern scanning.
function serializeExport(value: unknown): string {
  if (value instanceof Buffer || value instanceof Uint8Array) {
    return Buffer.from(value).toString("ascii");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

describe("Pattern scan — no realistic PII in fixture exports", () => {
  it("self-test: scanner detects a deliberately realistic passport number", () => {
    expect(scanForPII("Passport AB1234567 issued")).toHaveLength(1);
  });

  it("self-test: scanner detects a 16-digit card number", () => {
    expect(scanForPII("card 4111111111111111 end")).toHaveLength(1);
  });

  const exportEntries = Object.entries(fixtures);

  for (const [exportName, value] of exportEntries) {
    it(`${exportName} contains no realistic PII patterns`, () => {
      const serialized = serializeExport(value);
      const found = scanForPII(serialized);
      expect(
        found,
        `${exportName} triggered PII pattern(s): ${found.map((f) => `${f.pattern}="${f.match}"`).join(", ")}`
      ).toHaveLength(0);
    });
  }
});
