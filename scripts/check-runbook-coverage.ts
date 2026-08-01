#!/usr/bin/env tsx
/**
 * Runbook coverage checker (WO-109 AC5).
 *
 * Validates two-way coverage between CloudWatch alarms in the Terraform SLO
 * module and the runbook index:
 *
 *   1. Every alarm_name in infra/terraform/ must appear in docs/runbooks/INDEX.md.
 *   2. Every alarm referenced in a runbook's **Alarm(s):** front-matter line
 *      must exist in the Terraform alarm list.
 *
 * Exits 0 when coverage is complete.
 * Exits 1 with a human-readable summary when coverage is incomplete.
 *
 * Rules:
 *   - Alarm names containing "${" (Terraform interpolation) are skipped in
 *     step 1 — they resolve at apply time and are documented separately in
 *     INDEX.md's "Variable-name Alarms" section.
 *   - Alarm names in runbooks are parsed from lines matching:
 *       **Alarm:** `<name>`
 *       **Alarms:** `<name1>`, `<name2>`
 *     (both singular and plural, backtick-delimited)
 *
 * Usage:
 *   npx tsx scripts/check-runbook-coverage.ts
 *   pnpm runbook:coverage-check
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const TF_DIR = join(REPO_ROOT, "infra", "terraform");
const RUNBOOK_DIR = join(REPO_ROOT, "docs", "runbooks");
const INDEX_FILE = join(RUNBOOK_DIR, "INDEX.md");

// ---------------------------------------------------------------------------
// Step 1: Extract alarm names from all .tf files
// ---------------------------------------------------------------------------

function extractTerraformAlarms(tfDir: string): Set<string> {
  const alarms = new Set<string>();
  const tfFiles = readdirSync(tfDir).filter((f) => f.endsWith(".tf"));

  for (const file of tfFiles) {
    const content = readFileSync(join(tfDir, file), "utf-8");
    // Match: alarm_name = "some-alarm-name"
    const matches = content.matchAll(/alarm_name\s*=\s*"([^"]+)"/g);
    for (const [, name] of matches) {
      // Skip Terraform interpolations — they resolve at apply time
      if (!name.includes("${")) {
        alarms.add(name);
      }
    }
  }

  return alarms;
}

// ---------------------------------------------------------------------------
// Step 2: Extract alarm names referenced in runbook files
// ---------------------------------------------------------------------------

function extractRunbookAlarms(runbookDir: string): Map<string, string[]> {
  // Maps alarm name → list of runbook files that reference it
  const alarmToRunbooks = new Map<string, string[]>();
  const mdFiles = readdirSync(runbookDir).filter((f) => f.endsWith(".md"));

  for (const file of mdFiles) {
    if (file === "INDEX.md" || file === "TEMPLATE.md") continue;
    const content = readFileSync(join(runbookDir, file), "utf-8");

    // Match **Alarm:** `name` or **Alarms:** `name1`, `name2`
    const lines = content.split("\n");
    for (const line of lines) {
      if (!/^\*\*Alarm[s]?\*\*:/i.test(line)) continue;
      // Extract all backtick-quoted alarm names from this line
      const alarmMatches = line.matchAll(/`([A-Z][A-Z0-9a-z-]+)`/g);
      for (const [, alarmName] of alarmMatches) {
        const existing = alarmToRunbooks.get(alarmName) ?? [];
        existing.push(file);
        alarmToRunbooks.set(alarmName, existing);
      }
    }
  }

  return alarmToRunbooks;
}

// ---------------------------------------------------------------------------
// Step 3: Extract alarm names from INDEX.md (the authoritative coverage map)
// ---------------------------------------------------------------------------

function extractIndexAlarms(indexFile: string): Set<string> {
  const alarms = new Set<string>();
  if (!existsSync(indexFile)) return alarms;

  const content = readFileSync(indexFile, "utf-8");
  // Match backtick-quoted alarm names in table rows
  const matches = content.matchAll(/`([A-Z][A-Z0-9a-z-]+)`/g);
  for (const [, name] of matches) {
    alarms.add(name);
  }
  return alarms;
}

// ---------------------------------------------------------------------------
// Step 4: Extract runbook file references from INDEX.md
// ---------------------------------------------------------------------------

function extractIndexRunbookRefs(indexFile: string): Set<string> {
  const refs = new Set<string>();
  if (!existsSync(indexFile)) return refs;

  const content = readFileSync(indexFile, "utf-8");
  // Match markdown links: [text](filename.md)
  const matches = content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g);
  for (const [, , filename] of matches) {
    refs.add(basename(filename));
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Collect data
  const tfAlarms = extractTerraformAlarms(TF_DIR);
  const runbookAlarms = extractRunbookAlarms(RUNBOOK_DIR);
  const indexAlarms = extractIndexAlarms(INDEX_FILE);
  const indexRunbookRefs = extractIndexRunbookRefs(INDEX_FILE);

  console.log(`\n[runbook-coverage] Terraform alarms found:  ${tfAlarms.size}`);
  console.log(`[runbook-coverage] Runbook alarm refs found: ${runbookAlarms.size}`);
  console.log(`[runbook-coverage] INDEX.md alarm entries:   ${indexAlarms.size}\n`);

  // ── Check 1: Every Terraform alarm must appear in INDEX.md ──────────────
  const unmappedAlarms: string[] = [];
  for (const alarm of tfAlarms) {
    if (!indexAlarms.has(alarm)) {
      unmappedAlarms.push(alarm);
    }
  }

  if (unmappedAlarms.length > 0) {
    errors.push(
      `FAIL: ${unmappedAlarms.length} alarm(s) in Terraform have no entry in INDEX.md:\n` +
      unmappedAlarms.map((a) => `  - ${a}`).join("\n") +
      "\n  Add each alarm to docs/runbooks/INDEX.md and link it to a runbook.",
    );
  }

  // ── Check 2: Every alarm in a runbook must exist in Terraform ────────────
  const phantomAlarms: Array<{ alarm: string; runbooks: string[] }> = [];
  for (const [alarm, runbooks] of runbookAlarms) {
    if (!tfAlarms.has(alarm)) {
      phantomAlarms.push({ alarm, runbooks });
    }
  }

  if (phantomAlarms.length > 0) {
    errors.push(
      `FAIL: ${phantomAlarms.length} alarm(s) referenced in runbooks do not exist in Terraform:\n` +
      phantomAlarms.map(({ alarm, runbooks }) =>
        `  - \`${alarm}\` (referenced in: ${runbooks.join(", ")})`,
      ).join("\n") +
      "\n  Either add the alarm to Terraform or remove it from the runbook.",
    );
  }

  // ── Check 3: Every runbook file referenced in INDEX.md must exist ────────
  const missingRunbooks: string[] = [];
  for (const ref of indexRunbookRefs) {
    const path = join(RUNBOOK_DIR, ref);
    if (!existsSync(path)) {
      missingRunbooks.push(ref);
    }
  }

  if (missingRunbooks.length > 0) {
    errors.push(
      `FAIL: ${missingRunbooks.length} runbook file(s) referenced in INDEX.md do not exist:\n` +
      missingRunbooks.map((f) => `  - docs/runbooks/${f}`).join("\n"),
    );
  }

  // ── Check 4: INDEX.md must exist ─────────────────────────────────────────
  if (!existsSync(INDEX_FILE)) {
    errors.push(`FAIL: docs/runbooks/INDEX.md does not exist.`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`[runbook-coverage] WARN: ${w}`);
    }
  }

  if (errors.length === 0) {
    console.log("[runbook-coverage] PASS: All alarms are mapped to runbooks.");
    console.log(`  ${tfAlarms.size} Terraform alarms → ${indexAlarms.size} INDEX.md entries`);
    process.exit(0);
  }

  console.error("\n[runbook-coverage] COVERAGE INCOMPLETE:\n");
  for (const error of errors) {
    console.error(error);
    console.error();
  }

  console.error(
    "[runbook-coverage] Fix the issues above, then re-run:\n" +
    "  npx tsx scripts/check-runbook-coverage.ts\n",
  );
  process.exit(1);
}

main();
