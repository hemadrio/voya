#!/usr/bin/env tsx
/**
 * Dashboard metric-existence validator (WO-111 AC5).
 *
 * Reads the typed widget definition manifest (scripts/dashboard-metrics-manifest.json)
 * and verifies every {namespace, metricName} pair is listed in the committed
 * metric catalogue (docs/measurement/METRIC_CATALOGUE.md).
 *
 * Exits 0 when all metrics are catalogued.
 * Exits 1 with a named-metric error when any widget references an uncatalogued metric.
 *
 * Usage:
 *   npx tsx scripts/validate-dashboard-metrics.ts
 *   pnpm dashboard:validate-metrics
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const MANIFEST_FILE = join(REPO_ROOT, "scripts", "dashboard-metrics-manifest.json");
const CATALOGUE_FILE = join(REPO_ROOT, "docs", "measurement", "METRIC_CATALOGUE.md");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricRef {
  namespace: string;
  metricName: string;
}

export interface WidgetDefinition {
  widgetTitle: string;
  panelGroup: string;
  metrics: MetricRef[];
}

// ---------------------------------------------------------------------------
// Catalogue parser
//
// Parses table rows from METRIC_CATALOGUE.md with the format:
//   | `namespace` | `metric_name` | ... |
// Returns a Set of "namespace::metricName" keys.
// ---------------------------------------------------------------------------

export function parseCatalogue(content: string): Set<string> {
  const catalogued = new Set<string>();
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(content)) !== null) {
    const [, namespace, metricName] = match;
    if (namespace && metricName) {
      catalogued.add(`${namespace}::${metricName}`);
    }
  }
  return catalogued;
}

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

export function parseManifest(content: string): WidgetDefinition[] {
  return JSON.parse(content) as WidgetDefinition[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  widgetTitle: string;
  panelGroup: string;
  namespace: string;
  metricName: string;
}

export function validateManifestAgainstCatalogue(
  widgets: WidgetDefinition[],
  catalogued: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const widget of widgets) {
    for (const metric of widget.metrics) {
      const key = `${metric.namespace}::${metric.metricName}`;
      if (!catalogued.has(key)) {
        errors.push({
          widgetTitle: widget.widgetTitle,
          panelGroup: widget.panelGroup,
          namespace: metric.namespace,
          metricName: metric.metricName,
        });
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const catalogueContent = readFileSync(CATALOGUE_FILE, "utf-8");
  const manifestContent = readFileSync(MANIFEST_FILE, "utf-8");

  const catalogued = parseCatalogue(catalogueContent);
  const widgets = parseManifest(manifestContent);

  console.log(`\n[dashboard-metrics] Catalogue entries: ${catalogued.size}`);
  console.log(`[dashboard-metrics] Widget definitions: ${widgets.length}`);

  const errors = validateManifestAgainstCatalogue(widgets, catalogued);

  if (errors.length === 0) {
    console.log("[dashboard-metrics] PASS: All dashboard metrics are catalogued.\n");
    process.exit(0);
  }

  console.error(`\n[dashboard-metrics] FAIL: ${errors.length} metric(s) referenced in the dashboard manifest are not in the metric catalogue:\n`);
  for (const err of errors) {
    console.error(`  Widget: "${err.widgetTitle}" (${err.panelGroup})`);
    console.error(`    Missing: namespace="${err.namespace}" metricName="${err.metricName}"`);
    console.error(`    Action: add this metric to docs/measurement/METRIC_CATALOGUE.md before wiring it into the dashboard.\n`);
  }
  console.error("[dashboard-metrics] Fix the issues above, then re-run:\n  npx tsx scripts/validate-dashboard-metrics.ts\n");
  process.exit(1);
}

main();
