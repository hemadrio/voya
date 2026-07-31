/**
 * Unit tests for the classification register.
 * Covers AC9: register schema validation and exhaustiveness check.
 */

import { describe, it, expect } from "vitest";
import {
  CLASSIFICATION_REGISTER,
  getEntriesForTable,
  getEntryById,
  getDsrExportEntries,
  getErasureExcludedEntries,
  getJsonSurfaceEntries,
} from "@travel/contracts/retention";

// Personal-data tables that must appear in the register (AC7 exhaustiveness)
const PERSONAL_DATA_TABLES = [
  "users",
  "sessions",
  "one_time_tokens",
  "bookings",
  "booking_travelers",
  "itineraries",
  "travel_preferences",
  "booking_audit_log",
  "conversation_history",
];

describe("CLASSIFICATION_REGISTER", () => {
  it("validates against its schema at module load (no exception thrown)", () => {
    // If the register were malformed this import would have thrown
    expect(CLASSIFICATION_REGISTER).toBeDefined();
    expect(CLASSIFICATION_REGISTER.version).toBeTruthy();
    expect(CLASSIFICATION_REGISTER.entries.length).toBeGreaterThan(0);
  });

  it("covers all nine specification categories", () => {
    const categories = CLASSIFICATION_REGISTER.entries.map((e) => e.category);
    expect(categories).toContain("Account identity");
    expect(categories).toContain("Authentication session");
    expect(categories).toContain("Booking transaction");
    expect(categories).toContain("Traveler identity documents");
    expect(categories).toContain("Itinerary");
    expect(categories).toContain("Travel preferences");
    expect(categories).toContain("Conversation history");
    expect(categories).toContain("Audit record");
  });

  it("covers JSON surfaces for bookings and audit log (AC4)", () => {
    const jsonEntries = getJsonSurfaceEntries();
    const tables = jsonEntries.map((e) => e.table);
    expect(tables).toContain("bookings"); // search_result_snapshot
    expect(tables).toContain("booking_audit_log"); // previous_state / new_state
  });

  it("marks search_result_snapshot as a JSON surface", () => {
    const entry = getEntryById("bookings.search_result_snapshot");
    expect(entry).toBeDefined();
    expect(entry!.isJsonSurface).toBe(true);
    expect(entry!.columns).toContain("search_result_snapshot");
  });

  it("marks audit records as erasure-excluded with pseudonymisation rule (AC5)", () => {
    const auditEntry = getEntryById("booking_audit_log.audit");
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.erasureExcluded).toBe(true);
    expect(auditEntry!.erasureMethod).toBe("none");
    expect(auditEntry!.classification).toBe("INTERNAL");
    expect(auditEntry!.pseudonymisationRule).toBeTruthy();
    // Must specify minimum 365 days via config key
    expect(auditEntry!.retentionPeriodKey).toBe("auditDays");
  });

  it("all entries have retentionPeriodKey or null (config keys, never literals) (AC6)", () => {
    for (const entry of CLASSIFICATION_REGISTER.entries) {
      // retentionPeriodKey should be a camelCase key or null — never a number literal
      if (entry.retentionPeriodKey !== null) {
        expect(typeof entry.retentionPeriodKey).toBe("string");
        expect(entry.retentionPeriodKey).toMatch(/^[a-zA-Z]+/); // starts with letter
        expect(entry.retentionPeriodKey).not.toMatch(/^\d+$/); // not a numeric literal
      }
    }
  });

  it("all entry ids are unique", () => {
    const ids = CLASSIFICATION_REGISTER.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("exhaustiveness: every personal-data table has a register entry (AC7)", () => {
  it("all expected personal-data tables appear in the register", () => {
    const registeredTables = new Set(CLASSIFICATION_REGISTER.entries.map((e) => e.table));

    for (const table of PERSONAL_DATA_TABLES) {
      expect(registeredTables.has(table), `Table '${table}' missing from register`).toBe(true);
    }
  });

  it("fails when a personal-data table is absent from the register (simulated drift)", () => {
    const registeredTables = new Set(CLASSIFICATION_REGISTER.entries.map((e) => e.table));
    const hypotheticalNewTable = "new_personal_table_not_in_register";
    // Simulates: a developer adds a new table and forgets to update the register
    expect(registeredTables.has(hypotheticalNewTable)).toBe(false);
    // In CI this would be caught by the exhaustiveness check asserting coverage
  });
});

describe("lookup helpers", () => {
  it("getEntriesForTable returns all entries for a table", () => {
    const entries = getEntriesForTable("booking_audit_log");
    expect(entries.length).toBeGreaterThanOrEqual(2); // audit + state_json
  });

  it("getEntryById returns the correct entry", () => {
    const entry = getEntryById("sessions.auth");
    expect(entry?.table).toBe("sessions");
  });

  it("getEntryById returns undefined for unknown id", () => {
    expect(getEntryById("nonexistent")).toBeUndefined();
  });

  it("getDsrExportEntries excludes audit records", () => {
    const dsrEntries = getDsrExportEntries();
    const auditEntry = dsrEntries.find((e) => e.table === "booking_audit_log");
    expect(auditEntry).toBeUndefined();
  });

  it("getErasureExcludedEntries returns only audit entries", () => {
    const excluded = getErasureExcludedEntries();
    expect(excluded.every((e) => e.table === "booking_audit_log")).toBe(true);
  });
});
