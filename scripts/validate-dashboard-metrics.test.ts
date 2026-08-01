/**
 * Unit tests for scripts/validate-dashboard-metrics.ts (WO-111 AC10).
 *
 * Tests cover:
 *   - parseCatalogue: extracts namespace+metricName pairs from markdown table rows
 *   - parseManifest: parses WidgetDefinition array from JSON
 *   - validateManifestAgainstCatalogue: pass, single missing metric, multiple missing
 *   - Dashboard JSON builder: widget array is non-empty and each widget has required fields
 */

import { describe, it, expect } from "vitest";
import {
  parseCatalogue,
  parseManifest,
  validateManifestAgainstCatalogue,
  type WidgetDefinition,
  type MetricRef,
} from "./validate-dashboard-metrics.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function catalogueWithMetrics(entries: Array<{ namespace: string; metric: string }>): string {
  const header = "| namespace | metric_name | dimensions | stat | owner |\n|---|---|---|---|---|\n";
  const rows = entries
    .map(({ namespace, metric }) => `| \`${namespace}\` | \`${metric}\` | environment | Sum | test |`)
    .join("\n");
  return header + rows;
}

function manifestWith(widgets: Array<{ title: string; group: string; metrics: MetricRef[] }>): string {
  return JSON.stringify(
    widgets.map(({ title, group, metrics }) => ({
      widgetTitle: title,
      panelGroup: group,
      metrics,
    })),
  );
}

// ---------------------------------------------------------------------------
// parseCatalogue
// ---------------------------------------------------------------------------

describe("parseCatalogue", () => {
  it("extracts namespace::metricName pairs from markdown table rows", () => {
    const content = catalogueWithMetrics([
      { namespace: "travel/funnel", metric: "funnel_events_total" },
      { namespace: "travel/assistant", metric: "assistant_cost_per_completed_booking_usd" },
    ]);
    const result = parseCatalogue(content);
    expect(result.has("travel/funnel::funnel_events_total")).toBe(true);
    expect(result.has("travel/assistant::assistant_cost_per_completed_booking_usd")).toBe(true);
  });

  it("handles multiple namespaces in a single catalogue", () => {
    const content = catalogueWithMetrics([
      { namespace: "AWS/ApplicationELB", metric: "RequestCount" },
      { namespace: "AWS/SQS", metric: "ApproximateAgeOfOldestMessage" },
      { namespace: "travel/ci", metric: "test_coverage_pct" },
    ]);
    const result = parseCatalogue(content);
    expect(result.size).toBe(3);
    expect(result.has("AWS/ApplicationELB::RequestCount")).toBe(true);
    expect(result.has("travel/ci::test_coverage_pct")).toBe(true);
  });

  it("returns empty set for a catalogue with no table rows", () => {
    const result = parseCatalogue("# Metric Catalogue\n\nNo metrics listed yet.\n");
    expect(result.size).toBe(0);
  });

  it("ignores header rows (namespace / metric_name text)", () => {
    const content = "| namespace | metric_name | dimensions |\n|---|---|---|\n| `travel/funnel` | `funnel_events_total` | environment |\n";
    const result = parseCatalogue(content);
    // "namespace" and "metric_name" themselves are not in backticks in header, so not captured
    expect(result.has("namespace::metric_name")).toBe(false);
    expect(result.has("travel/funnel::funnel_events_total")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

describe("parseManifest", () => {
  it("parses a valid manifest JSON into WidgetDefinition[]", () => {
    const json = manifestWith([
      {
        title: "Test Widget",
        group: "funnel-conversion",
        metrics: [{ namespace: "travel/funnel", metricName: "funnel_events_total" }],
      },
    ]);
    const result = parseManifest(json);
    expect(result).toHaveLength(1);
    expect(result[0]?.widgetTitle).toBe("Test Widget");
    expect(result[0]?.metrics[0]?.namespace).toBe("travel/funnel");
  });

  it("handles a widget with multiple metric refs", () => {
    const json = manifestWith([
      {
        title: "Multi-Metric Widget",
        group: "availability",
        metrics: [
          { namespace: "AWS/ApplicationELB", metricName: "RequestCount" },
          { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_5XX_Count" },
        ],
      },
    ]);
    const result = parseManifest(json);
    expect(result[0]?.metrics).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateManifestAgainstCatalogue — PASS
// ---------------------------------------------------------------------------

describe("validateManifestAgainstCatalogue — PASS", () => {
  it("returns no errors when all widget metrics are in the catalogue", () => {
    const catalogued = new Set(["travel/funnel::funnel_events_total", "travel/assistant::AssistantFirstTokenP95"]);
    const widgets: WidgetDefinition[] = [
      {
        widgetTitle: "Funnel Widget",
        panelGroup: "funnel-conversion",
        metrics: [{ namespace: "travel/funnel", metricName: "funnel_events_total" }],
      },
      {
        widgetTitle: "Latency Widget",
        panelGroup: "latency",
        metrics: [{ namespace: "travel/assistant", metricName: "AssistantFirstTokenP95" }],
      },
    ];
    const errors = validateManifestAgainstCatalogue(widgets, catalogued);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateManifestAgainstCatalogue — FAIL: single missing metric
// ---------------------------------------------------------------------------

describe("validateManifestAgainstCatalogue — FAIL: single missing metric", () => {
  it("returns one error naming the missing metric and its widget", () => {
    const catalogued = new Set(["travel/funnel::funnel_events_total"]);
    const widgets: WidgetDefinition[] = [
      {
        widgetTitle: "Funnel Widget",
        panelGroup: "funnel-conversion",
        metrics: [{ namespace: "travel/funnel", metricName: "funnel_events_total" }],
      },
      {
        widgetTitle: "New Guardrail Widget",
        panelGroup: "guardrails",
        metrics: [{ namespace: "travel/new", metricName: "new_metric_not_in_catalogue" }],
      },
    ];
    const errors = validateManifestAgainstCatalogue(widgets, catalogued);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.namespace).toBe("travel/new");
    expect(errors[0]?.metricName).toBe("new_metric_not_in_catalogue");
    expect(errors[0]?.widgetTitle).toBe("New Guardrail Widget");
  });
});

// ---------------------------------------------------------------------------
// validateManifestAgainstCatalogue — FAIL: multiple missing metrics
// ---------------------------------------------------------------------------

describe("validateManifestAgainstCatalogue — FAIL: multiple missing metrics", () => {
  it("reports all missing metrics across all widgets", () => {
    const catalogued = new Set<string>();  // deliberately empty
    const widgets: WidgetDefinition[] = [
      {
        widgetTitle: "Widget A",
        panelGroup: "latency",
        metrics: [
          { namespace: "travel/search", metricName: "SearchResponseP95" },
          { namespace: "travel/checkout", metricName: "CheckoutAckP95" },
        ],
      },
    ];
    const errors = validateManifestAgainstCatalogue(widgets, catalogued);
    expect(errors).toHaveLength(2);
    const metricNames = errors.map((e) => e.metricName);
    expect(metricNames).toContain("SearchResponseP95");
    expect(metricNames).toContain("CheckoutAckP95");
  });
});

// ---------------------------------------------------------------------------
// Dashboard JSON builder test — widget structure correctness
// ---------------------------------------------------------------------------

describe("Dashboard widget structure", () => {
  it("all manifest entries have widgetTitle, panelGroup, and at least one metric", () => {
    const { readFileSync } = require("node:fs");
    const { join, resolve } = require("node:path");
    const manifestPath = join(resolve(__dirname, ".."), "scripts", "dashboard-metrics-manifest.json");
    const widgets: WidgetDefinition[] = parseManifest(readFileSync(manifestPath, "utf-8"));

    expect(widgets.length).toBeGreaterThan(0);

    for (const widget of widgets) {
      expect(typeof widget.widgetTitle).toBe("string");
      expect(widget.widgetTitle.length).toBeGreaterThan(0);
      expect(typeof widget.panelGroup).toBe("string");
      expect(["funnel-conversion", "latency", "availability", "guardrails"]).toContain(widget.panelGroup);
      expect(widget.metrics.length).toBeGreaterThan(0);
      for (const m of widget.metrics) {
        expect(typeof m.namespace).toBe("string");
        expect(typeof m.metricName).toBe("string");
        expect(m.namespace.length).toBeGreaterThan(0);
        expect(m.metricName.length).toBeGreaterThan(0);
      }
    }
  });

  it("all manifest metrics are in METRIC_CATALOGUE.md (integration guard)", () => {
    const { readFileSync } = require("node:fs");
    const { join, resolve } = require("node:path");
    const root = resolve(__dirname, "..");
    const manifest: WidgetDefinition[] = parseManifest(readFileSync(join(root, "scripts", "dashboard-metrics-manifest.json"), "utf-8"));
    const catalogue = parseCatalogue(readFileSync(join(root, "docs", "measurement", "METRIC_CATALOGUE.md"), "utf-8"));
    const errors = validateManifestAgainstCatalogue(manifest, catalogue);
    expect(errors, `Uncatalogued metrics: ${JSON.stringify(errors)}`).toHaveLength(0);
  });
});
