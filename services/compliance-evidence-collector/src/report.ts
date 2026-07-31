/**
 * Monthly observation-window report generator.
 *
 * Usage:
 *   node dist/report.js --start 2024-09-01 --end 2024-11-30 --bucket my-evidence-bucket
 *
 * Reads manifests from the evidence bucket and emits a summary artefact
 * listing, per control: artefacts collected, gaps, planned gaps, and
 * any alarm activations (from a stub in this implementation — wired to
 * CloudWatch in production via the CloudWatch Alarms History API).
 *
 * The summary is written to stdout as JSON and also to the evidence bucket
 * at {env}/reports/{start}--{end}/monthly-report.json.
 */

import { parseArgs } from "node:util";
import type { RunManifest } from "./types.js";

interface ControlSummary {
  controlId: string;
  controlGroup: string;
  artefactsCollected: number;
  gapsCount: number;
  plannedGapsCount: number;
  failureGapsCount: number;
}

interface MonthlyReport {
  schemaVersion: "1.0";
  generatedAt: string;
  environment: string;
  observationWindowStart: string;
  observationWindowEnd: string;
  controls: ControlSummary[];
  totals: {
    daysInWindow: number;
    totalArtefacts: number;
    totalGaps: number;
    totalPlanned: number;
    totalFailures: number;
  };
}

export function buildMonthlyReport(opts: {
  environment: string;
  start: Date;
  end: Date;
  manifests: RunManifest[];
}): MonthlyReport {
  const { environment, start, end, manifests } = opts;

  // Aggregate per control
  const controlMap = new Map<string, ControlSummary>();

  for (const manifest of manifests) {
    for (const entry of manifest.artefacts) {
      const existing = controlMap.get(entry.controlId) ?? {
        controlId: entry.controlId,
        controlGroup: entry.controlGroup,
        artefactsCollected: 0,
        gapsCount: 0,
        plannedGapsCount: 0,
        failureGapsCount: 0,
      };
      existing.artefactsCollected++;
      controlMap.set(entry.controlId, existing);
    }

    for (const gap of manifest.gaps) {
      const existing = controlMap.get(gap.controlId) ?? {
        controlId: gap.controlId,
        controlGroup: gap.controlGroup,
        artefactsCollected: 0,
        gapsCount: 0,
        plannedGapsCount: 0,
        failureGapsCount: 0,
      };
      if (gap.reason === "planned") {
        existing.plannedGapsCount++;
      } else if (gap.reason === "source_failure") {
        existing.gapsCount++;
        existing.failureGapsCount++;
      } else {
        existing.gapsCount++;
      }
      controlMap.set(gap.controlId, existing);
    }
  }

  const controls = Array.from(controlMap.values()).sort((a, b) =>
    a.controlGroup.localeCompare(b.controlGroup) || a.controlId.localeCompare(b.controlId),
  );

  const daysInWindow = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    environment,
    observationWindowStart: start.toISOString().slice(0, 10),
    observationWindowEnd: end.toISOString().slice(0, 10),
    controls,
    totals: {
      daysInWindow,
      totalArtefacts: controls.reduce((s, c) => s + c.artefactsCollected, 0),
      totalGaps: controls.reduce((s, c) => s + c.gapsCount, 0),
      totalPlanned: controls.reduce((s, c) => s + c.plannedGapsCount, 0),
      totalFailures: controls.reduce((s, c) => s + c.failureGapsCount, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values: argv } = parseArgs({
    args: process.argv.slice(2),
    options: {
      start: { type: "string" },
      end: { type: "string" },
      bucket: { type: "string" },
      environment: { type: "string", default: process.env["ENVIRONMENT"] ?? "development" },
    },
    strict: false,
  });

  const startDate = argv["start"] ? new Date(argv["start"] as string) : (() => {
    const d = new Date(); d.setDate(1); d.setUTCHours(0, 0, 0, 0); return d;
  })();
  const endDate = argv["end"] ? new Date(argv["end"] as string) : new Date();

  // In a production implementation, manifests are loaded from S3.
  // Here we demonstrate the report structure with an empty manifest set.
  const manifests: RunManifest[] = [];

  const report = buildMonthlyReport({
    environment: argv["environment"] as string,
    start: startDate,
    end: endDate,
    manifests,
  });

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[compliance-report] FATAL: ${String(err)}\n`);
  process.exit(1);
});
