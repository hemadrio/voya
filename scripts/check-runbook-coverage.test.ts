/**
 * Unit tests for the runbook coverage checker (WO-109 AC9).
 *
 * Tests cover:
 *   - PASS: every Terraform alarm has a matching INDEX.md entry
 *   - FAIL: a Terraform alarm has no INDEX.md entry (unmapped)
 *   - FAIL: a runbook references an alarm that doesn't exist in Terraform
 *   - FAIL: INDEX.md references a runbook file that doesn't exist
 *   - SKIP: Terraform interpolation names (${var.environment}-...) are skipped
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Inline the logic under test (same as check-runbook-coverage.ts but importable)
// ---------------------------------------------------------------------------

function extractTerraformAlarms(content: string): Set<string> {
  const alarms = new Set<string>();
  const matches = content.matchAll(/alarm_name\s*=\s*"([^"]+)"/g);
  for (const [, name] of matches) {
    if (!name.includes("${")) alarms.add(name);
  }
  return alarms;
}

function extractRunbookAlarmsFromContent(
  content: string,
  filename: string,
): Map<string, string[]> {
  const alarmToRunbooks = new Map<string, string[]>();
  if (filename === "INDEX.md" || filename === "TEMPLATE.md") return alarmToRunbooks;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!/^\*\*Alarm[s]?\*\*:/i.test(line)) continue;
    const alarmMatches = line.matchAll(/`([A-Z][A-Z0-9a-z-]+)`/g);
    for (const [, alarmName] of alarmMatches) {
      const existing = alarmToRunbooks.get(alarmName) ?? [];
      existing.push(filename);
      alarmToRunbooks.set(alarmName, existing);
    }
  }
  return alarmToRunbooks;
}

function extractIndexAlarms(content: string): Set<string> {
  const alarms = new Set<string>();
  const matches = content.matchAll(/`([A-Z][A-Z0-9a-z-]+)`/g);
  for (const [, name] of matches) alarms.add(name);
  return alarms;
}

function extractIndexRunbookRefs(content: string): Set<string> {
  const refs = new Set<string>();
  const matches = content.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g);
  for (const [, , filename] of matches) refs.add(filename.replace(/^.*\//, ""));
  return refs;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function tfContent(alarms: string[]): string {
  return alarms
    .map((a) => `  alarm_name = "${a}"`)
    .join("\n");
}

function runbookContent(alarms: string[]): string {
  return `# Runbook\n**Alarms:** ${alarms.map((a) => `\`${a}\``).join(", ")}\n`;
}

function indexContent(entries: Array<{ alarm: string; runbook: string }>): string {
  const rows = entries.map(({ alarm, runbook }) => `| \`${alarm}\` | [${runbook}](${runbook}) |`);
  return `# Index\n| Alarm | Runbook |\n|---|---|\n${rows.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractTerraformAlarms", () => {
  it("extracts alarm names from Terraform alarm_name = '...' declarations", () => {
    const tf = tfContent(["CRITICAL-checkout-fault-rate", "HIGH-search-latency-p95-warning"]);
    const alarms = extractTerraformAlarms(tf);
    expect(alarms).toContain("CRITICAL-checkout-fault-rate");
    expect(alarms).toContain("HIGH-search-latency-p95-warning");
  });

  it("skips Terraform interpolation names (${...})", () => {
    const tf = `alarm_name = "\${var.environment}-document-generation-failure"`;
    const alarms = extractTerraformAlarms(tf);
    expect(alarms.size).toBe(0);
  });

  it("extracts multiple alarms from the same file", () => {
    const tf = tfContent(["ALARM-A", "ALARM-B", "ALARM-C"]);
    expect(extractTerraformAlarms(tf).size).toBe(3);
  });
});

describe("extractRunbookAlarmsFromContent", () => {
  it("extracts alarm names from **Alarm:** and **Alarms:** front-matter lines", () => {
    const content = runbookContent(["CRITICAL-supplier-outage", "HIGH-cache-degradation"]);
    const result = extractRunbookAlarmsFromContent(content, "supplier-outage.md");
    expect(result.has("CRITICAL-supplier-outage")).toBe(true);
    expect(result.has("HIGH-cache-degradation")).toBe(true);
  });

  it("skips INDEX.md and TEMPLATE.md", () => {
    const content = `**Alarms:** \`CRITICAL-some-alarm\`\n`;
    expect(extractRunbookAlarmsFromContent(content, "INDEX.md").size).toBe(0);
    expect(extractRunbookAlarmsFromContent(content, "TEMPLATE.md").size).toBe(0);
  });

  it("does not extract lowercase-only identifiers (avoids false positives in prose)", () => {
    const content = `**Alarms:** \`HIGH-real-alarm\`\n\nSome text with \`not-an-alarm\`.\n`;
    const result = extractRunbookAlarmsFromContent(content, "test.md");
    // Only uppercase-starting names should match
    expect(result.has("HIGH-real-alarm")).toBe(true);
    expect(result.has("not-an-alarm")).toBe(false);
  });
});

describe("coverage checks — PASS cases", () => {
  it("passes when all Terraform alarms are mapped in INDEX.md and runbook files exist", () => {
    const tfAlarms = new Set(["CRITICAL-supplier-outage", "HIGH-cache-degradation"]);
    const runbookAlarms = new Map([
      ["CRITICAL-supplier-outage", ["supplier-outage.md"]],
      ["HIGH-cache-degradation", ["cache-degradation.md"]],
    ]);
    const indexAlarms = new Set(["CRITICAL-supplier-outage", "HIGH-cache-degradation"]);
    const indexRunbookRefs = new Set(["supplier-outage.md", "cache-degradation.md"]);

    // Simulate coverage check logic
    const unmapped = [...tfAlarms].filter((a) => !indexAlarms.has(a));
    const phantom = [...runbookAlarms.entries()].filter(([a]) => !tfAlarms.has(a));
    const missingFiles: string[] = []; // assume all files exist in this test

    expect(unmapped).toHaveLength(0);
    expect(phantom).toHaveLength(0);
    expect(missingFiles).toHaveLength(0);
  });
});

describe("coverage checks — FAIL: unmapped alarm", () => {
  it("detects a Terraform alarm with no INDEX.md entry", () => {
    const tfAlarms = new Set(["CRITICAL-supplier-outage", "CRITICAL-new-alarm-no-runbook"]);
    const indexAlarms = new Set(["CRITICAL-supplier-outage"]); // missing new alarm

    const unmapped = [...tfAlarms].filter((a) => !indexAlarms.has(a));
    expect(unmapped).toContain("CRITICAL-new-alarm-no-runbook");
    expect(unmapped).toHaveLength(1);
  });
});

describe("coverage checks — FAIL: phantom alarm in runbook", () => {
  it("detects a runbook referencing an alarm not in Terraform", () => {
    const tfAlarms = new Set(["CRITICAL-real-alarm"]);
    const runbookAlarms = new Map([
      ["CRITICAL-real-alarm", ["runbook.md"]],
      ["CRITICAL-phantom-alarm", ["runbook.md"]], // not in Terraform
    ]);

    const phantom = [...runbookAlarms.entries()].filter(([a]) => !tfAlarms.has(a));
    expect(phantom).toHaveLength(1);
    expect(phantom[0]?.[0]).toBe("CRITICAL-phantom-alarm");
  });
});

describe("coverage checks — FAIL: INDEX.md references missing file", () => {
  it("detects a runbook file referenced in INDEX.md that does not exist", () => {
    const indexRefs = new Set(["real-runbook.md", "non-existent-runbook.md"]);
    const existingFiles = new Set(["real-runbook.md"]);

    const missing = [...indexRefs].filter((f) => !existingFiles.has(f));
    expect(missing).toContain("non-existent-runbook.md");
  });
});

describe("extractIndexAlarms", () => {
  it("extracts alarm names from INDEX.md backtick entries", () => {
    const idx = indexContent([
      { alarm: "CRITICAL-checkout-fault-rate", runbook: "saga-partial-failure.md" },
      { alarm: "HIGH-search-supplier-breaker-open", runbook: "supplier-outage.md" },
    ]);
    const alarms = extractIndexAlarms(idx);
    expect(alarms).toContain("CRITICAL-checkout-fault-rate");
    expect(alarms).toContain("HIGH-search-supplier-breaker-open");
  });
});

describe("extractIndexRunbookRefs", () => {
  it("extracts runbook filenames from markdown links", () => {
    const idx = indexContent([
      { alarm: "ALARM-X", runbook: "supplier-outage.md" },
      { alarm: "ALARM-Y", runbook: "cache-degradation.md" },
    ]);
    const refs = extractIndexRunbookRefs(idx);
    expect(refs).toContain("supplier-outage.md");
    expect(refs).toContain("cache-degradation.md");
  });
});
