/**
 * Unit tests for migration-lint.ts — WO-086.
 *
 * Covers:
 *   - SQL statement classification (all destructive kinds + safe cases)
 *   - Statement splitting (comments, multi-statement files, malformed SQL)
 *   - Expand registry loading + validation
 *   - hasExpandEntry matching logic
 *   - lintFile integration over fixture SQL files
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  classifyStatement,
  splitStatements,
  loadRegistry,
  hasExpandEntry,
  lintFile,
  type ExpandRegistry,
} from "./migration-lint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── classifyStatement ─────────────────────────────────────────────────────────

describe("classifyStatement", () => {
  describe("DROP TABLE", () => {
    it("detects DROP TABLE", () => {
      const r = classifyStatement("DROP TABLE users");
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("DROP_TABLE");
      expect(r.changeKey).toBe("users");
    });

    it("detects DROP TABLE IF EXISTS", () => {
      const r = classifyStatement("DROP TABLE IF EXISTS legacy_sessions");
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("DROP_TABLE");
      expect(r.changeKey).toBe("legacy_sessions");
    });
  });

  describe("DROP COLUMN", () => {
    it("detects ALTER TABLE ... DROP COLUMN", () => {
      const r = classifyStatement("ALTER TABLE bookings DROP COLUMN old_field");
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("DROP_COLUMN");
      expect(r.changeKey).toBe("bookings.old_field");
    });

    it("detects DROP COLUMN IF EXISTS", () => {
      const r = classifyStatement(
        "ALTER TABLE users DROP COLUMN IF EXISTS legacy_phone"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("DROP_COLUMN");
      expect(r.changeKey).toBe("users.legacy_phone");
    });
  });

  describe("RENAME COLUMN", () => {
    it("detects column rename", () => {
      const r = classifyStatement(
        "ALTER TABLE users RENAME COLUMN email_address TO email"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("RENAME_COLUMN");
      expect(r.changeKey).toBe("users.email_address");
    });
  });

  describe("TYPE_CHANGE", () => {
    it("detects ALTER COLUMN ... TYPE", () => {
      const r = classifyStatement(
        "ALTER TABLE bookings ALTER COLUMN total_price TYPE NUMERIC(10,2)"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("TYPE_CHANGE");
      expect(r.changeKey).toBe("bookings.total_price");
    });

    it("detects ALTER COLUMN ... SET DATA TYPE", () => {
      const r = classifyStatement(
        "ALTER TABLE payments ALTER COLUMN amount SET DATA TYPE BIGINT"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("TYPE_CHANGE");
      expect(r.changeKey).toBe("payments.amount");
    });
  });

  describe("NOT_NULL_WITHOUT_DEFAULT", () => {
    it("detects ADD COLUMN NOT NULL without DEFAULT", () => {
      const r = classifyStatement(
        "ALTER TABLE bookings ADD COLUMN confirmed_at TIMESTAMPTZ NOT NULL"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("NOT_NULL_WITHOUT_DEFAULT");
    });

    it("does NOT flag ADD COLUMN NOT NULL WITH DEFAULT as destructive", () => {
      const r = classifyStatement(
        "ALTER TABLE bookings ADD COLUMN confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()"
      );
      expect(r.destructive).toBe(false);
    });
  });

  describe("CREATE_INDEX_CONCURRENTLY", () => {
    it("flags CREATE INDEX CONCURRENTLY for review", () => {
      const r = classifyStatement(
        "CREATE INDEX CONCURRENTLY idx_bookings_user ON bookings(user_id)"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("CREATE_INDEX_CONCURRENTLY");
    });

    it("flags CREATE UNIQUE INDEX CONCURRENTLY", () => {
      const r = classifyStatement(
        "CREATE UNIQUE INDEX CONCURRENTLY idx_users_email ON users(email)"
      );
      expect(r.destructive).toBe(true);
      expect(r.kind).toBe("CREATE_INDEX_CONCURRENTLY");
    });
  });

  describe("safe statements", () => {
    it("allows CREATE TABLE", () => {
      const r = classifyStatement(
        "CREATE TABLE IF NOT EXISTS new_feature (id UUID PRIMARY KEY)"
      );
      expect(r.destructive).toBe(false);
    });

    it("allows ADD COLUMN nullable", () => {
      const r = classifyStatement(
        "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT"
      );
      expect(r.destructive).toBe(false);
    });

    it("allows CREATE INDEX (non-concurrent)", () => {
      const r = classifyStatement(
        "CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)"
      );
      expect(r.destructive).toBe(false);
    });

    it("allows INSERT", () => {
      const r = classifyStatement(
        "INSERT INTO schema_version (version) VALUES ('001')"
      );
      expect(r.destructive).toBe(false);
    });
  });
});

// ── splitStatements ───────────────────────────────────────────────────────────

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    const sql = "CREATE TABLE a (id INT); ALTER TABLE b ADD COLUMN x TEXT;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE TABLE");
    expect(stmts[1]).toContain("ALTER TABLE");
  });

  it("strips -- line comments", () => {
    const sql = "-- drop the old column\nALTER TABLE t DROP COLUMN c;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).not.toContain("--");
  });

  it("strips block comments", () => {
    const sql = "/* deprecated */ DROP TABLE legacy;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).not.toContain("deprecated");
  });

  it("handles empty-statement sections (e.g. trailing semicolons)", () => {
    const sql = "CREATE TABLE a (id INT);;";
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
  });

  it("handles completely empty SQL gracefully", () => {
    const stmts = splitStatements("-- only comments\n-- nothing here");
    expect(stmts).toHaveLength(0);
  });

  it("handles malformed/truncated SQL without throwing", () => {
    const sql = "ALTER TABLE users DROP COLUMN old";
    // No semicolon — should still produce one statement
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
  });
});

// ── loadRegistry ──────────────────────────────────────────────────────────────

describe("loadRegistry", () => {
  it("returns empty registry when file does not exist", () => {
    const r = loadRegistry("/nonexistent/path/expand-registry.yaml");
    expect(r.entries).toHaveLength(0);
  });

  it("loads and validates a valid registry YAML", () => {
    const r = loadRegistry(join(FIXTURES, "expand-registry-valid.yaml"));
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries[0]).toMatchObject({
      change_id: expect.any(String),
      table: expect.any(String),
      expand_release: expect.any(String),
    });
  });

  it("throws on duplicate change_id", () => {
    expect(() =>
      loadRegistry(join(FIXTURES, "expand-registry-duplicate-id.yaml"))
    ).toThrow(/duplicate change_id/);
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      loadRegistry(join(FIXTURES, "expand-registry-missing-fields.yaml"))
    ).toThrow(/missing required fields/);
  });
});

// ── hasExpandEntry ────────────────────────────────────────────────────────────

describe("hasExpandEntry", () => {
  const registry: ExpandRegistry = {
    entries: [
      {
        change_id: "users-email-rename-001",
        table: "users",
        column: "email_address",
        expand_release: "v1.2.0",
      },
      {
        change_id: "bookings-drop-legacy-col",
        table: "bookings",
        column: "old_status",
        expand_release: "v1.3.0",
      },
      {
        change_id: "sessions-drop-table",
        table: "legacy_sessions",
        expand_release: "v1.4.0",
      },
    ],
  };

  it("matches RENAME_COLUMN by table + column", () => {
    expect(hasExpandEntry(registry, "RENAME_COLUMN", "users.email_address")).toBe(true);
  });

  it("does not match RENAME_COLUMN for unknown column", () => {
    expect(hasExpandEntry(registry, "RENAME_COLUMN", "users.unknown_col")).toBe(false);
  });

  it("matches DROP_COLUMN by table + column", () => {
    expect(hasExpandEntry(registry, "DROP_COLUMN", "bookings.old_status")).toBe(true);
  });

  it("matches DROP_TABLE by table name", () => {
    expect(hasExpandEntry(registry, "DROP_TABLE", "legacy_sessions")).toBe(true);
  });

  it("does not match DROP_TABLE for unknown table", () => {
    expect(hasExpandEntry(registry, "DROP_TABLE", "nonexistent")).toBe(false);
  });
});

// ── lintFile (integration over fixtures) ─────────────────────────────────────

const emptyRegistry: ExpandRegistry = { entries: [] };

describe("lintFile — destructive fixture files", () => {
  it("reports DROP_COLUMN violation", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-drop-column.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("DROP_COLUMN");
  });

  it("reports DROP_TABLE violation", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-drop-table.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("DROP_TABLE");
  });

  it("reports RENAME_COLUMN violation", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-rename-column.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("RENAME_COLUMN");
  });

  it("reports TYPE_CHANGE violation", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-type-narrowing.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("TYPE_CHANGE");
  });

  it("reports NOT_NULL_WITHOUT_DEFAULT violation", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-not-null-no-default.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("NOT_NULL_WITHOUT_DEFAULT");
  });

  it("flags CREATE_INDEX_CONCURRENTLY for review", () => {
    const violations = lintFile(
      join(FIXTURES, "destructive-concurrent-index.sql"),
      emptyRegistry
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].kind).toBe("CREATE_INDEX_CONCURRENTLY");
  });
});

describe("lintFile — safe fixture files", () => {
  it("reports no violations for safe ADD COLUMN", () => {
    const violations = lintFile(
      join(FIXTURES, "safe-add-column.sql"),
      emptyRegistry
    );
    expect(violations).toHaveLength(0);
  });

  it("reports no violations for safe CREATE TABLE", () => {
    const violations = lintFile(
      join(FIXTURES, "safe-create-table.sql"),
      emptyRegistry
    );
    expect(violations).toHaveLength(0);
  });

  it("reports no violations for safe CREATE INDEX (non-concurrent)", () => {
    const violations = lintFile(
      join(FIXTURES, "safe-create-index.sql"),
      emptyRegistry
    );
    expect(violations).toHaveLength(0);
  });
});

describe("lintFile — expand entry suppresses violation", () => {
  it("allows DROP_COLUMN when expand entry exists", () => {
    const registry: ExpandRegistry = {
      entries: [
        {
          change_id: "bookings-drop-old-notes",
          table: "bookings",
          column: "old_notes",
          expand_release: "v1.5.0",
        },
      ],
    };
    // destructive-drop-column.sql drops bookings.old_notes
    const violations = lintFile(
      join(FIXTURES, "destructive-drop-column.sql"),
      registry
    );
    expect(violations).toHaveLength(0);
  });
});

describe("lintFile — malformed SQL", () => {
  it("does not throw on malformed/truncated SQL", () => {
    expect(() =>
      lintFile(join(FIXTURES, "malformed-truncated.sql"), emptyRegistry)
    ).not.toThrow();
  });
});
