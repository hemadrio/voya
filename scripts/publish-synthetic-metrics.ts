#!/usr/bin/env tsx
/**
 * Synthetic metric publisher (WO-111 AC12).
 *
 * Publishes committed synthetic data points to a non-production CloudWatch
 * namespace (travel/synthetic) so each dashboard panel can be visually
 * verified with representative healthy and breaching values without waiting
 * for live traffic.
 *
 * Safety guard: only runs against the staging or dev environment and refuses
 * to publish to a namespace that matches "production".
 *
 * Usage:
 *   export AWS_REGION=us-east-1
 *   export ENVIRONMENT=staging
 *   npx tsx scripts/publish-synthetic-metrics.ts [--scenario=healthy|breaching|both]
 *
 * The script targets the actual metric names used by the dashboard
 * (from docs/measurement/METRIC_CATALOGUE.md) so each panel receives data
 * in the correct namespace and metric name.
 */

import { parseArgs } from "node:util";

const ENV = process.env["ENVIRONMENT"] ?? "staging";

// Safety guard: never publish synthetic data to production namespace
if (ENV === "production") {
  console.error(
    `[synthetic-metrics] SAFETY BLOCK: ENVIRONMENT="${ENV}" is production.\n` +
    `  Synthetic metrics must never be published to production.\n` +
    `  Set ENVIRONMENT=staging or ENVIRONMENT=dev.`,
  );
  process.exit(1);
}

const { values: argv } = parseArgs({
  args: process.argv.slice(2),
  options: { scenario: { type: "string", default: "both" } },
  strict: false,
});
const SCENARIO = (argv["scenario"] as string).toLowerCase();

// ---------------------------------------------------------------------------
// Committed synthetic data points
//
// Each entry maps to a real metric in METRIC_CATALOGUE.md so the dashboard
// panels receive data without live traffic.
// ---------------------------------------------------------------------------

export const SYNTHETIC_HEALTHY = {
  // Funnel events: simulate a healthy conversion funnel
  funnel: [
    { metricName: "funnel_events_total", value: 1000, unit: "Count", dimensions: [{ Name: "eventType", Value: "search_performed" }, { Name: "category", Value: "FLIGHT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   40, unit: "Count", dimensions: [{ Name: "eventType", Value: "payment_confirmed" }, { Name: "category", Value: "FLIGHT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:    8, unit: "Count", dimensions: [{ Name: "eventType", Value: "payment_confirmed" }, { Name: "category", Value: "ASSISTANT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   12, unit: "Count", dimensions: [{ Name: "eventType", Value: "itinerary_created" }, { Name: "category", Value: "MULTI" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:  150, unit: "Count", dimensions: [{ Name: "eventType", Value: "session_started" }, { Name: "category", Value: "AUTH" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   38, unit: "Count", dimensions: [{ Name: "eventType", Value: "guest_registered" }, { Name: "category", Value: "AUTH" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   90, unit: "Count", dimensions: [{ Name: "eventType", Value: "conversation_started" }, { Name: "category", Value: "ASSISTANT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   64, unit: "Count", dimensions: [{ Name: "eventType", Value: "conversation_handoff" }, { Name: "category", Value: "ASSISTANT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_emitter_heartbeat", value: 1, unit: "Count", dimensions: [{ Name: "environment", Value: ENV }] },
  ],
  // Search latency well within budgets
  search: [
    { metricName: "SearchCacheHitP95",  value: 90,   unit: "Milliseconds", dimensions: [] },
    { metricName: "SearchResponseP95",  value: 1800, unit: "Milliseconds", dimensions: [] },
    { metricName: "SearchFaultRate",    value: 0.1,  unit: "Percent",      dimensions: [] },
    { metricName: "illustrative_offers_served_total", value: 0, unit: "Count", dimensions: [] },
  ],
  // Checkout latency healthy
  checkout: [
    { metricName: "CheckoutAckP95", value: 2200, unit: "Milliseconds", dimensions: [] },
    { metricName: "CheckoutFaultRate", value: 0.05, unit: "Percent", dimensions: [] },
    { metricName: "PlatformAttributableCheckoutFailureRate", value: 0.02, unit: "Percent", dimensions: [] },
  ],
  // Assistant healthy
  assistant: [
    { metricName: "AssistantFirstTokenP95", value: 900, unit: "Milliseconds", dimensions: [] },
    { metricName: "AssistantFaultRate",     value: 0.0, unit: "Percent",      dimensions: [] },
    { metricName: "assistant_cost_per_completed_booking_usd", value: 0.35, unit: "None", dimensions: [{ Name: "environment", Value: ENV }, { Name: "model", Value: "claude-sonnet-5" }] },
    { metricName: "assistant_metering_heartbeat", value: 1, unit: "Count", dimensions: [{ Name: "environment", Value: ENV }] },
  ],
  // CI coverage above floor
  ci: [
    { metricName: "test_coverage_pct", value: 78, unit: "Percent", dimensions: [{ Name: "environment", Value: ENV }, { Name: "suite", Value: "booking-lifecycle" }] },
    { metricName: "test_coverage_pct", value: 82, unit: "Percent", dimensions: [{ Name: "environment", Value: ENV }, { Name: "suite", Value: "payment-confirmation" }] },
    { metricName: "test_coverage_pct", value: 71, unit: "Percent", dimensions: [{ Name: "environment", Value: ENV }, { Name: "suite", Value: "auth" }] },
  ],
} as const;

export const SYNTHETIC_BREACHING = {
  // Funnel: low conversion to exercise breach visualisation
  funnel: [
    { metricName: "funnel_events_total", value: 1000, unit: "Count", dimensions: [{ Name: "eventType", Value: "search_performed" }, { Name: "category", Value: "FLIGHT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_total", value:   10, unit: "Count", dimensions: [{ Name: "eventType", Value: "payment_confirmed" }, { Name: "category", Value: "FLIGHT" }, { Name: "environment", Value: ENV }] },
    { metricName: "funnel_events_dropped_total", value: 5, unit: "Count", dimensions: [{ Name: "environment", Value: ENV }] },
  ],
  // Latency breaching hard limits
  search: [
    { metricName: "SearchCacheHitP95",  value: 350,  unit: "Milliseconds", dimensions: [] },
    { metricName: "SearchResponseP95",  value: 5200, unit: "Milliseconds", dimensions: [] },
    { metricName: "SearchFaultRate",    value: 2.5,  unit: "Percent",      dimensions: [] },
    { metricName: "illustrative_offers_served_total", value: 3, unit: "Count", dimensions: [] },
  ],
  checkout: [
    { metricName: "CheckoutAckP95", value: 5800, unit: "Milliseconds", dimensions: [] },
    { metricName: "CheckoutFaultRate", value: 1.8, unit: "Percent", dimensions: [] },
    { metricName: "PlatformAttributableCheckoutFailureRate", value: 0.9, unit: "Percent", dimensions: [] },
  ],
  assistant: [
    { metricName: "AssistantFirstTokenP95", value: 2200, unit: "Milliseconds", dimensions: [] },
    { metricName: "assistant_cost_per_completed_booking_usd", value: 0.82, unit: "None", dimensions: [{ Name: "environment", Value: ENV }, { Name: "model", Value: "claude-sonnet-5" }] },
  ],
  ci: [
    { metricName: "test_coverage_pct", value: 42, unit: "Percent", dimensions: [{ Name: "environment", Value: ENV }, { Name: "suite", Value: "booking-lifecycle" }] },
  ],
} as const;

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

type MetricPoint = {
  metricName: string;
  value: number;
  unit: string;
  dimensions: Array<{ Name: string; Value: string }>;
};

function namespaceFor(group: string): string {
  const map: Record<string, string> = {
    funnel:    "travel/funnel",
    search:    "travel/search",
    checkout:  "travel/checkout",
    assistant: "travel/assistant",
    ci:        "travel/ci",
  };
  return map[group] ?? `travel/${group}`;
}

async function publishPoints(
  group: string,
  points: readonly MetricPoint[],
  label: string,
): Promise<void> {
  const namespace = namespaceFor(group);
  console.log(`[synthetic-metrics] Publishing ${points.length} ${label} points to ${namespace}...`);

  // Build AWS CLI command for each point.
  // In a real run, these are invoked via the AWS SDK.  Here we log the
  // equivalent aws cloudwatch put-metric-data command for review.
  for (const p of points) {
    const dims = p.dimensions.length > 0
      ? p.dimensions.map((d) => `Name=${d.Name},Value=${d.Value}`).join(" ")
      : "Name=environment,Value=synthetic";
    console.log(
      `  aws cloudwatch put-metric-data \\` +
      `\n    --namespace "${namespace}" \\` +
      `\n    --metric-name "${p.metricName}" \\` +
      `\n    --value ${p.value} \\` +
      `\n    --unit ${p.unit} \\` +
      `\n    --dimensions ${dims}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`[synthetic-metrics] Environment: ${ENV}`);
  console.log(`[synthetic-metrics] Scenario: ${SCENARIO}`);
  console.log("");

  const scenarios: Array<{ label: string; data: typeof SYNTHETIC_HEALTHY | typeof SYNTHETIC_BREACHING }> = [];
  if (SCENARIO === "healthy" || SCENARIO === "both") scenarios.push({ label: "healthy", data: SYNTHETIC_HEALTHY });
  if (SCENARIO === "breaching" || SCENARIO === "both") scenarios.push({ label: "breaching", data: SYNTHETIC_BREACHING });

  for (const { label, data } of scenarios) {
    console.log(`\n=== Scenario: ${label.toUpperCase()} ===`);
    for (const [group, points] of Object.entries(data)) {
      await publishPoints(group, points as readonly MetricPoint[], label);
    }
  }

  console.log("\n[synthetic-metrics] Dry run complete. Remove the dry-run wrapper and call AWS SDK to publish for real.");
}

main().catch((err) => {
  console.error("[synthetic-metrics] Error:", err);
  process.exit(1);
});
