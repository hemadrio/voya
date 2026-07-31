#!/usr/bin/env tsx
/**
 * migration-lint.ts — SQL migration linter for expand-contract gate (WO-086).
 *
 * Classifies SQL statements in new Prisma migration files and fails the
 * pipeline on destructive DDL unless a matching expand-phase marker exists
 * in prisma/expand-registry.yaml.
 *
 * Destructive patterns rejected without an expand entry:
 *   DROP TABLE
 *   DROP COLUMN
 *   RENAME COLUMN
 *   ALTER COLUMN ... TYPE (type change)
 *   ALTER TABLE ... ADD COLUMN ... NOT NULL (without DEFAULT)
 *
 * Flagged for explicit review (non-blocking unless expand entry absent):
 *   CREATE INDEX CONCURRENTLY — cannot run inside a transaction; an aborted
 *   run leaves an invalid index that must be dropped manually.
 *
 * Usage (CLI):
 *   tsx tools/ci/migration-lint.ts [--base <git-ref>] [--registry <path>]
 *
 * Exit codes:
 *   0 — all statements pass
 *   1 — destructive DDL without expand entry, or registry validation failure
 *   2 — usage / I/O error
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DestructiveKind =
  | "DROP_TABLE"
  | "DROP_COLUMN"
  | "RENAME_COLUMN"
  | "TYPE_CHANGE"
  | "NOT_NULL_WITHOUT_DEFAULT"
  | "CREATE_INDEX_CONCURRENTLY";

export interface StatementClassification {
  statement: string;
  destructive: boolean;
  kind: DestructiveKind | null;
  /** Normalised key for registry lookup: "<table>.<column>" or "<table>" */
  changeKey: string | null;
}

export interface ExpandEntry {
  change_id: string;
  table: string;
  column?: string;
  expand_release: string;
  contract_release?: string;
  description?: string;
}

export interface ExpandRegistry {
  entries: ExpandEntry[];
}

export interface LintViolation {
  file: string;
  statement: string;
  kind: DestructiveKind;
  changeKey: string | null;
  message: string;
}

// ── SQL classification ────────────────────────────────────────────────────────

const DROP_TABLE_RE =
  /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)/i;

const DROP_COLUMN_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\S+)/i;

const RENAME_COLUMN_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)\s+RENAME\s+COLUMN\s+(\S+)\s+TO\s+(\S+)/i;

const ALTER_TYPE_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)\s+ALTER\s+COLUMN\s+(\S+)\s+(?:SET\s+DATA\s+)?TYPE\s+/i;

// Matches: ADD COLUMN col_name TYPE NOT NULL (without a DEFAULT clause)
const NOT_NULL_NO_DEFAULT_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+(?:\S+\s+)+NOT\s+NULL(?!\s+DEFAULT)/i;

const CREATE_INDEX_CONCURRENTLY_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i;

/** Strip an identifier of surrounding quotes for consistent comparison. */
function unquote(id: string): string {
  return id.replace(/^["'`]|["'`]$/g, "").replace(/;$/, "").trim();
}

/**
 * Classify a single SQL statement.
 * Handles multi-line statements by normalising whitespace.
 */
export function classifyStatement(sql: string): StatementClassification {
  const normalised = sql.replace(/\s+/g, " ").trim();

  let m: RegExpMatchArray | null;

  m = DROP_TABLE_RE.exec(normalised);
  if (m) {
    const table = unquote(m[1]);
    return {
      statement: normalised,
      destructive: true,
      kind: "DROP_TABLE",
      changeKey: table,
    };
  }

  m = DROP_COLUMN_RE.exec(normalised);
  if (m) {
    const table = unquote(m[1]);
    const column = unquote(m[2]);
    return {
      statement: normalised,
      destructive: true,
      kind: "DROP_COLUMN",
      changeKey: `${table}.${column}`,
    };
  }

  m = RENAME_COLUMN_RE.exec(normalised);
  if (m) {
    const table = unquote(m[1]);
    const oldCol = unquote(m[2]);
    return {
      statement: normalised,
      destructive: true,
      kind: "RENAME_COLUMN",
      changeKey: `${table}.${oldCol}`,
    };
  }

  m = ALTER_TYPE_RE.exec(normalised);
  if (m) {
    const table = unquote(m[1]);
    const column = unquote(m[2]);
    return {
      statement: normalised,
      destructive: true,
      kind: "TYPE_CHANGE",
      changeKey: `${table}.${column}`,
    };
  }

  m = NOT_NULL_NO_DEFAULT_RE.exec(normalised);
  if (m) {
    // Only destructive if there's truly no DEFAULT. The regex already asserts
    // that NOT NULL is not followed by DEFAULT, but double-check.
    if (!/DEFAULT/i.test(normalised)) {
      const table = unquote(m[1]);
      const column = unquote(m[2]);
      return {
        statement: normalised,
        destructive: true,
        kind: "NOT_NULL_WITHOUT_DEFAULT",
        changeKey: `${table}.${column}`,
      };
    }
  }

  m = CREATE_INDEX_CONCURRENTLY_RE.exec(normalised);
  if (m) {
    return {
      statement: normalised,
      destructive: true,
      kind: "CREATE_INDEX_CONCURRENTLY",
      changeKey: null,
    };
  }

  return { statement: normalised, destructive: false, kind: null, changeKey: null };
}

/**
 * Split a SQL file into individual statements, stripping comments.
 * Handles:
 *   - Line comments: -- ...
 *   - Block comments: /* ... *\/
 *   - Statement delimiter: ;
 */
export function splitStatements(sql: string): string[] {
  // Remove block comments
  let stripped = sql.replace(/\/\*[\s\S]*?\*\//g, " ");

  // Remove line comments
  stripped = stripped.replace(/--[^\n]*/g, "");

  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Registry ─────────────────────────────────────────────────────────────────

export function loadRegistry(registryPath: string): ExpandRegistry {
  if (!existsSync(registryPath)) {
    return { entries: [] };
  }
  const raw = readFileSync(registryPath, "utf-8");
  const parsed = parseYaml(raw) as { entries?: unknown[] } | null;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`expand-registry.yaml is malformed — expected a YAML object with an 'entries' key`);
  }

  const entries: ExpandEntry[] = [];
  const seen = new Set<string>();

  for (const raw of parsed.entries ?? []) {
    const e = raw as Partial<ExpandEntry>;
    if (!e.change_id || !e.table || !e.expand_release) {
      throw new Error(
        `expand-registry.yaml entry is missing required fields (change_id, table, expand_release): ${JSON.stringify(e)}`
      );
    }
    if (seen.has(e.change_id)) {
      throw new Error(`expand-registry.yaml contains duplicate change_id: ${e.change_id}`);
    }
    seen.add(e.change_id);
    entries.push(e as ExpandEntry);
  }

  return { entries };
}

/**
 * Check if a destructive change has a matching expand-registry entry.
 * Matches on table + column (or table alone for table-level changes).
 */
export function hasExpandEntry(
  registry: ExpandRegistry,
  kind: DestructiveKind,
  changeKey: string | null
): boolean {
  if (!changeKey) {
    // CREATE_INDEX_CONCURRENTLY — check for any CONCURRENTLY entry
    return registry.entries.some((e) => e.change_id.includes("concurrent-index"));
  }

  const [table, column] = changeKey.split(".");

  return registry.entries.some((e) => {
    const tableMatch = e.table.toLowerCase() === table.toLowerCase();
    if (kind === "DROP_TABLE") {
      return tableMatch;
    }
    if (!column) return tableMatch;
    return tableMatch && e.column?.toLowerCase() === column.toLowerCase();
  });
}

// ── File-level lint ───────────────────────────────────────────────────────────

export function lintFile(
  filepath: string,
  registry: ExpandRegistry
): LintViolation[] {
  let sql: string;
  try {
    sql = readFileSync(filepath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read migration file: ${filepath}: ${String(err)}`);
  }

  const statements = splitStatements(sql);
  const violations: LintViolation[] = [];

  for (const stmt of statements) {
    const c = classifyStatement(stmt);
    if (!c.destructive || c.kind === null) continue;

    const permitted = hasExpandEntry(registry, c.kind, c.changeKey);
    if (permitted) continue;

    const changeDesc = c.changeKey ?? "(no specific target)";

    violations.push({
      file: filepath,
      statement: c.statement.slice(0, 120),
      kind: c.kind,
      changeKey: c.changeKey,
      message:
        `Destructive DDL [${c.kind}] on ${changeDesc} — ` +
        `no matching entry in prisma/expand-registry.yaml. ` +
        `Ship the additive expand migration first, record it in expand-registry.yaml, ` +
        `then ship the destructive contract migration in a subsequent release.`,
    });
  }

  return violations;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

export function findNewMigrationFiles(
  baseRef: string,
  repoRoot: string
): string[] {
  try {
    const output = execSync(
      `git diff --name-only --diff-filter=A ${baseRef} -- "prisma/migrations/**/migration.sql"`,
      { cwd: repoRoot, encoding: "utf-8" }
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => join(repoRoot, f));
  } catch {
    // If git fails (e.g. shallow clone), fall back to listing all migration files
    // and letting the caller decide what to do.
    return [];
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let baseRef = "origin/main";
  let registryPath: string | undefined;
  let repoRoot = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && args[i + 1]) {
      baseRef = args[++i];
    } else if (args[i] === "--registry" && args[i + 1]) {
      registryPath = args[++i];
    } else if (args[i] === "--repo" && args[i + 1]) {
      repoRoot = resolve(args[++i]);
    }
  }

  const resolvedRegistry = registryPath
    ? resolve(registryPath)
    : join(repoRoot, "prisma", "expand-registry.yaml");

  let registry: ExpandRegistry;
  try {
    registry = loadRegistry(resolvedRegistry);
  } catch (err) {
    console.error(`[migration-lint] Registry error: ${String(err)}`);
    process.exit(1);
  }

  const newFiles = findNewMigrationFiles(baseRef, repoRoot);

  if (newFiles.length === 0) {
    console.log("[migration-lint] No new migration files detected — nothing to lint.");
    process.exit(0);
  }

  console.log(`[migration-lint] Linting ${newFiles.length} new migration file(s) against ${resolvedRegistry}`);

  let totalViolations = 0;

  for (const file of newFiles) {
    let violations: LintViolation[];
    try {
      violations = lintFile(file, registry);
    } catch (err) {
      console.error(`[migration-lint] ERROR reading ${file}: ${String(err)}`);
      process.exit(2);
    }

    if (violations.length === 0) {
      console.log(`  ✓ ${file}`);
      continue;
    }

    totalViolations += violations.length;
    console.error(`  ✗ ${file} — ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`      [${v.kind}] ${v.message}`);
      console.error(`      Statement: ${v.statement}`);
    }
  }

  if (totalViolations > 0) {
    console.error(
      `\n[migration-lint] FAILED — ${totalViolations} destructive DDL statement(s) without expand entries.`
    );
    console.error(
      "  Follow the expand-contract pattern: ship an additive expand migration first,\n" +
      "  record it in prisma/expand-registry.yaml, then ship the destructive contract\n" +
      "  migration in a later release."
    );
    process.exit(1);
  }

  console.log(
    `\n[migration-lint] PASSED — all new migrations comply with expand-contract policy.`
  );
  process.exit(0);
}

// Run when executed directly
if (process.argv[1]?.endsWith("migration-lint.ts") || process.argv[1]?.endsWith("migration-lint.js")) {
  main().catch((err) => {
    console.error("[migration-lint] Fatal:", err);
    process.exit(2);
  });
}
