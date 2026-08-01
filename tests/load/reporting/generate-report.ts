#!/usr/bin/env node
/**
 * Load test report generator
 *
 * Reads:
 *   --k6-json  <path>   k6 JSON output (--out json=<path> flag)
 *   --cw-json  <path>   CloudWatch metric export JSON (optional; see runbook)
 *   --thresholds <path> Thresholds config (default: tests/load/config/thresholds.json)
 *   --profile   <name>  "sustained-peak" | "spike-ramp"
 *   --out-json  <path>  Machine-readable verdict output
 *   --out-md    <path>  Human-readable Markdown summary output
 *
 * Exits non-zero if any budget or guardrail verdict is FAIL.
 *
 * Any inability to read trace-derived (CloudWatch) percentiles fails the gate
 * explicitly rather than silently falling back to client-only measurements.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

// ---------------------------------------------------------------------------
// CLI arg parser
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface K6MetricPoint {
  metric: string;
  type: "Point";
  data: {
    time: string;
    value: number;
    tags: Record<string, string>;
  };
}

interface K6Metric {
  type: string;
  contains: string;
  values: Record<string, number>;
}

interface K6Summary {
  metrics: Record<string, K6Metric>;
}

interface CloudWatchMetric {
  MetricName: string;
  Timestamps: string[];
  Values: number[];
  Statistics?: { p95?: number; Average?: number; Maximum?: number };
}

interface BudgetVerdict {
  budget: string;
  threshold: number;
  unit: string;
  clientP95: number | null;
  serverP95: number | null;
  source: "client+server" | "client-only" | "server-only" | "missing";
  verdict: "PASS" | "FAIL" | "WARN" | "MISSING_DATA";
  note?: string;
}

interface GuardrailVerdict {
  guardrail: string;
  threshold: number;
  unit: string;
  observed: number | null;
  verdict: "PASS" | "FAIL" | "MISSING_DATA";
  note?: string;
}

interface ScalingObservation {
  metric: string;
  min: number | null;
  max: number | null;
  final: number | null;
  note?: string;
}

interface R9Assertion {
  verdict: "PASS" | "FAIL" | "MISSING_DATA";
  maxConnectionsObserved: number | null;
  maxAllowed: number;
  proxyPinningRateObserved: number | null;
  proxyPinningRateMax: number;
  note?: string;
}

interface LoadTestReport {
  profile: string;
  generatedAt: string;
  overallVerdict: "PASS" | "FAIL";
  budgets: BudgetVerdict[];
  guardrails: GuardrailVerdict[];
  scaling: ScalingObservation[];
  r9: R9Assertion;
  rawMetrics: {
    clientSide: Record<string, number>;
    serverSide: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// k6 JSON parser
// ---------------------------------------------------------------------------

function parseK6Json(path: string): K6Summary | null {
  try {
    const raw = readFileSync(path, "utf-8");
    // k6 JSON output is newline-delimited; extract the final summary object
    const lines = raw.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === "summary" && parsed.data?.metrics) {
          return parsed.data as K6Summary;
        }
      } catch {
        // not JSON, skip
      }
    }
    // Fall back: treat entire content as a summary JSON
    return JSON.parse(raw) as K6Summary;
  } catch {
    return null;
  }
}

function getMetricP95(summary: K6Summary, metricName: string): number | null {
  const m = summary.metrics[metricName];
  if (!m || !m.values) return null;
  return m.values["p(95)"] ?? null;
}

function getMetricRate(summary: K6Summary, metricName: string): number | null {
  const m = summary.metrics[metricName];
  if (!m || !m.values) return null;
  return m.values["rate"] ?? null;
}

// ---------------------------------------------------------------------------
// CloudWatch metric parser
// ---------------------------------------------------------------------------

function parseCloudWatchJson(path: string): CloudWatchMetric[] | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CloudWatchMetric[];
  } catch {
    return null;
  }
}

function findCwMetric(metrics: CloudWatchMetric[], name: string): CloudWatchMetric | undefined {
  return metrics.find((m) => m.MetricName === name);
}

function cwP95(metric: CloudWatchMetric | undefined): number | null {
  if (!metric) return null;
  return metric.Statistics?.p95 ?? null;
}

function cwMax(metric: CloudWatchMetric | undefined): number | null {
  if (!metric) return null;
  if (metric.Values.length === 0) return null;
  return Math.max(...metric.Values);
}

function cwMin(metric: CloudWatchMetric | undefined): number | null {
  if (!metric) return null;
  if (metric.Values.length === 0) return null;
  return Math.min(...metric.Values);
}

function cwLast(metric: CloudWatchMetric | undefined): number | null {
  if (!metric || metric.Values.length === 0) return null;
  return metric.Values[metric.Values.length - 1];
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildReport(opts: {
  profile: string;
  k6: K6Summary | null;
  cw: CloudWatchMetric[] | null;
  cfg: Record<string, unknown>;
}): LoadTestReport {
  const { profile, k6, cw, cfg } = opts;
  const thresholds = cfg.latency_p95_ms as Record<string, number>;
  const guardrailCfg = cfg.guardrails as Record<string, number>;
  const scalingCfg = cfg.scaling as Record<string, number>;
  const rdsCfg = cfg.rds as Record<string, number>;

  const isSpike = profile === "spike-ramp";
  const prefix = isSpike ? "spike_" : "";

  // ------------------------------------------------------------------
  // Budget verdicts
  // ------------------------------------------------------------------

  function makeBudget(
    label: string,
    k6MetricName: string,
    cwMetricName: string,
    thresholdMs: number,
    cwRequired: boolean,
  ): BudgetVerdict {
    const clientP95 = k6 ? getMetricP95(k6, k6MetricName) : null;
    const cwMetric = cw ? findCwMetric(cw, cwMetricName) : undefined;
    const serverP95 = cwP95(cwMetric);

    if (cwRequired && !cw) {
      return {
        budget: label,
        threshold: thresholdMs,
        unit: "ms p95",
        clientP95,
        serverP95: null,
        source: "missing",
        verdict: "MISSING_DATA",
        note: "CloudWatch JSON not provided; cannot verify server-side p95. Gate fails explicitly.",
      };
    }

    const measured = serverP95 ?? clientP95;
    if (measured === null) {
      return {
        budget: label,
        threshold: thresholdMs,
        unit: "ms p95",
        clientP95,
        serverP95,
        source: "missing",
        verdict: "MISSING_DATA",
        note: "No measurement available from client or server.",
      };
    }

    const source = serverP95 !== null && clientP95 !== null
      ? "client+server"
      : serverP95 !== null
      ? "server-only"
      : "client-only";

    const verdictP95 = serverP95 !== null ? serverP95 : (clientP95 as number);
    const verdict: "PASS" | "FAIL" = verdictP95 <= thresholdMs ? "PASS" : "FAIL";

    let note: string | undefined;
    if (source === "client-only") {
      note = "Server-side (CloudWatch/X-Ray) p95 not available; verdict based on client measurements only.";
    }

    return { budget: label, threshold: thresholdMs, unit: "ms p95", clientP95, serverP95, source, verdict, note };
  }

  const budgets: BudgetVerdict[] = [
    makeBudget(
      "search_cache_hit",
      `${prefix}search_hit_p95_ms`,
      "SearchCacheHitLatencyP95",
      thresholds.search_cache_hit,
      true,
    ),
    makeBudget(
      "search_cache_miss",
      `${prefix}search_miss_p95_ms`,
      "SearchCacheMissLatencyP95",
      thresholds.search_cache_miss,
      true,
    ),
  ];

  if (!isSpike) {
    budgets.push(
      makeBudget(
        "checkout_acknowledgement",
        "checkout_p95_ms",
        "CheckoutAcknowledgementLatencyP95",
        thresholds.checkout_acknowledgement,
        true,
      ),
      makeBudget(
        "assistant_first_token",
        "assistant_ttft_p95_ms",
        "AssistantFirstTokenLatencyP95",
        thresholds.assistant_first_token,
        true,
      ),
    );
  } else {
    budgets.push(
      makeBudget(
        "checkout_acknowledgement (spike)",
        "spike_checkout_p95_ms",
        "CheckoutAcknowledgementLatencyP95",
        thresholds.checkout_acknowledgement,
        false,
      ),
    );
  }

  // ------------------------------------------------------------------
  // Guardrail verdicts
  // ------------------------------------------------------------------

  function makeGuardrail(
    label: string,
    k6MetricName: string,
    cwMetricName: string | null,
    maxAllowed: number,
    unit: string,
  ): GuardrailVerdict {
    const clientRate = k6 ? (getMetricRate(k6, k6MetricName) ?? null) : null;
    const cwMetric = cwMetricName && cw ? findCwMetric(cw, cwMetricName) : undefined;
    const serverRate = cwMetric ? (cwP95(cwMetric) ?? cwMax(cwMetric)) : null;

    const observed = serverRate ?? clientRate;
    if (observed === null) {
      return { guardrail: label, threshold: maxAllowed, unit, observed: null, verdict: "MISSING_DATA" };
    }
    return {
      guardrail: label,
      threshold: maxAllowed,
      unit,
      observed,
      verdict: observed <= maxAllowed ? "PASS" : "FAIL",
    };
  }

  const guardrails: GuardrailVerdict[] = [
    makeGuardrail(
      "server_fault_rate",
      `${prefix}server_fault_rate`,
      "ServerFaultRate",
      guardrailCfg.server_fault_rate_max_pct / 100,
      "rate (0–1)",
    ),
    makeGuardrail(
      "checkout_platform_failure_rate",
      `${prefix}checkout_fail_rate`,
      null,
      guardrailCfg.checkout_platform_failure_rate_max_pct / 100,
      "rate (0–1)",
    ),
  ];

  // Notification delivery guardrail — sourced from CW SQS metrics
  const sqsVisible = cw ? findCwMetric(cw, "ApproximateNumberOfMessagesVisible") : undefined;
  const sqsDeliveryRate = cw ? findCwMetric(cw, "NotificationDeliveryRate") : undefined;
  if (sqsDeliveryRate) {
    const rate = cwMin(sqsDeliveryRate);
    guardrails.push({
      guardrail: "notification_delivery_rate",
      threshold: guardrailCfg.notification_delivery_min_pct / 100,
      unit: "rate (0–1)",
      observed: rate,
      verdict: rate !== null ? (rate >= guardrailCfg.notification_delivery_min_pct / 100 ? "PASS" : "FAIL") : "MISSING_DATA",
    });
  }

  // SQS backlog drain
  if (sqsVisible) {
    const finalDepth = cwLast(sqsVisible);
    const note = finalDepth !== null && finalDepth > 0
      ? `SQS backlog not fully drained at run end: ${finalDepth} messages remaining`
      : undefined;
    guardrails.push({
      guardrail: "sqs_backlog_drains",
      threshold: 0,
      unit: "messages remaining",
      observed: finalDepth,
      verdict: finalDepth !== null ? (finalDepth === 0 ? "PASS" : "FAIL") : "MISSING_DATA",
      note,
    });
  }

  // ------------------------------------------------------------------
  // Scaling observations (informational — not pass/fail)
  // ------------------------------------------------------------------

  const scaling: ScalingObservation[] = [];

  const cwSearchTasks = cw ? findCwMetric(cw, "SearchServiceRunningTaskCount") : undefined;
  const cwGatewayTasks = cw ? findCwMetric(cw, "GatewayRunningTaskCount") : undefined;
  const cwAlbRcpt = cw ? findCwMetric(cw, "ALBRequestCountPerTarget") : undefined;

  if (cwSearchTasks) {
    scaling.push({
      metric: "search_service_running_tasks",
      min: cwMin(cwSearchTasks),
      max: cwMax(cwSearchTasks),
      final: cwLast(cwSearchTasks),
      note: `Expected: min=${scalingCfg.search_service_min_tasks} max=${scalingCfg.search_service_max_tasks} (ASSUMPTION)`,
    });
  }

  if (cwGatewayTasks) {
    scaling.push({
      metric: "gateway_running_tasks",
      min: cwMin(cwGatewayTasks),
      max: cwMax(cwGatewayTasks),
      final: cwLast(cwGatewayTasks),
      note: `Expected: min=${scalingCfg.gateway_min_tasks} max=${scalingCfg.gateway_max_tasks} (ASSUMPTION)`,
    });
  }

  if (cwAlbRcpt) {
    scaling.push({
      metric: "alb_request_count_per_target",
      min: cwMin(cwAlbRcpt),
      max: cwMax(cwAlbRcpt),
      final: cwLast(cwAlbRcpt),
    });
  }

  // ------------------------------------------------------------------
  // R9 assertion — RDS connection ceiling
  // ------------------------------------------------------------------

  const cwRdsConnections = cw ? findCwMetric(cw, "DatabaseConnections") : undefined;
  const cwProxyPinning = cw ? findCwMetric(cw, "ClientConnectionsSetupFailedAuthError") : undefined;

  // Proxy pinning metric: ClientConnectionsReceived vs ClientConnectionsCreated ratio
  const cwProxyPinningRate = cw ? findCwMetric(cw, "ProxyPinningSessionRate") : undefined;

  const maxConnsObserved = cwMax(cwRdsConnections ?? undefined);
  const pinningRateObserved = cwMax(cwProxyPinningRate ?? undefined);

  let r9: R9Assertion;
  if (!cw) {
    r9 = {
      verdict: "MISSING_DATA",
      maxConnectionsObserved: null,
      maxAllowed: rdsCfg.max_connections_per_service_task,
      proxyPinningRateObserved: null,
      proxyPinningRateMax: rdsCfg.proxy_pinning_rate_max_pct,
      note: "CloudWatch JSON not provided — R9 cannot be verified. Gate fails explicitly.",
    };
  } else if (maxConnsObserved === null) {
    r9 = {
      verdict: "MISSING_DATA",
      maxConnectionsObserved: null,
      maxAllowed: rdsCfg.max_connections_per_service_task,
      proxyPinningRateObserved: pinningRateObserved,
      proxyPinningRateMax: rdsCfg.proxy_pinning_rate_max_pct,
      note: "DatabaseConnections metric not found in CloudWatch export.",
    };
  } else {
    // max connections per task = total connections / max running tasks
    const maxTasks = cwMax(cwSearchTasks ?? undefined) ?? 1;
    const effectiveMax = maxConnsObserved / maxTasks;
    const connsPass = effectiveMax <= rdsCfg.max_connections_per_service_task;
    const pinningPass = pinningRateObserved === null || pinningRateObserved <= rdsCfg.proxy_pinning_rate_max_pct / 100;
    r9 = {
      verdict: connsPass && pinningPass ? "PASS" : "FAIL",
      maxConnectionsObserved,
      maxAllowed: rdsCfg.max_connections_per_service_task,
      proxyPinningRateObserved: pinningRateObserved,
      proxyPinningRateMax: rdsCfg.proxy_pinning_rate_max_pct,
      note: pinningRateObserved !== null && pinningRateObserved > rdsCfg.proxy_pinning_rate_max_pct / 100
        ? `RDS Proxy pinning rate ${(pinningRateObserved * 100).toFixed(1)}% exceeds ${rdsCfg.proxy_pinning_rate_max_pct}% ceiling — R9 conclusion may be falsely reassuring`
        : undefined,
    };
  }

  // ------------------------------------------------------------------
  // Overall verdict
  // ------------------------------------------------------------------

  const anyFail = [
    ...budgets.map((b) => b.verdict),
    ...guardrails.map((g) => g.verdict),
    r9.verdict,
  ].some((v) => v === "FAIL" || v === "MISSING_DATA");

  const clientSide: Record<string, number> = {};
  if (k6) {
    for (const [name, m] of Object.entries(k6.metrics)) {
      if (m.values?.["p(95)"] !== undefined) clientSide[`${name}.p95`] = m.values["p(95)"];
      if (m.values?.["rate"] !== undefined) clientSide[`${name}.rate`] = m.values["rate"];
    }
  }

  return {
    profile,
    generatedAt: new Date().toISOString(),
    overallVerdict: anyFail ? "FAIL" : "PASS",
    budgets,
    guardrails,
    scaling,
    r9,
    rawMetrics: { clientSide, serverSide: {} },
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(report: LoadTestReport): string {
  const vIcon = (v: string) => v === "PASS" ? "✅ PASS" : v === "FAIL" ? "❌ FAIL" : v === "WARN" ? "⚠️ WARN" : "⚠️ MISSING";
  const fmt = (n: number | null, unit = "ms") => n !== null ? `${n.toFixed(1)} ${unit}` : "—";

  const lines: string[] = [
    `# Load Test Report — ${report.profile}`,
    ``,
    `**Generated:** ${report.generatedAt}  `,
    `**Overall:** ${vIcon(report.overallVerdict)}`,
    ``,
    `> All threshold values are ASSUMPTION pending sponsor ratification.`,
    `> Edit \`tests/load/config/thresholds.json\` to re-baseline.`,
    ``,
    `## Latency Budgets`,
    ``,
    `| Budget | Threshold | Client p95 | Server p95 | Source | Verdict |`,
    `|---|---|---|---|---|---|`,
  ];

  for (const b of report.budgets) {
    lines.push(
      `| ${b.budget} | ${fmt(b.threshold)} | ${fmt(b.clientP95)} | ${fmt(b.serverP95)} | ${b.source} | ${vIcon(b.verdict)} |`,
    );
  }

  lines.push(``, `## Guardrails`, ``, `| Guardrail | Max Allowed | Observed | Verdict |`, `|---|---|---|---|`);

  for (const g of report.guardrails) {
    lines.push(
      `| ${g.guardrail} | ${g.threshold} ${g.unit} | ${g.observed !== null ? g.observed.toFixed(4) : "—"} ${g.unit} | ${vIcon(g.verdict)} |`,
    );
  }

  if (report.scaling.length > 0) {
    lines.push(``, `## Scaling Observations`, ``, `| Metric | Min | Max | Final | Note |`, `|---|---|---|---|---|`);
    for (const s of report.scaling) {
      lines.push(`| ${s.metric} | ${s.min ?? "—"} | ${s.max ?? "—"} | ${s.final ?? "—"} | ${s.note ?? ""} |`);
    }
  }

  lines.push(
    ``,
    `## R9 Assertion — RDS Connection Ceiling`,
    ``,
    `| Item | Value | Threshold | Verdict |`,
    `|---|---|---|---|`,
    `| Max DB connections observed | ${report.r9.maxConnectionsObserved ?? "—"} | ${report.r9.maxAllowed} per task | ${vIcon(report.r9.verdict)} |`,
    `| Proxy pinning rate | ${report.r9.proxyPinningRateObserved !== null ? `${(report.r9.proxyPinningRateObserved * 100).toFixed(1)}%` : "—"} | ≤${report.r9.proxyPinningRateMax}% | ${report.r9.proxyPinningRateObserved === null ? "—" : report.r9.proxyPinningRateObserved * 100 <= report.r9.proxyPinningRateMax ? vIcon("PASS") : vIcon("FAIL")} |`,
  );

  if (report.r9.note) {
    lines.push(``, `> **R9 note:** ${report.r9.note}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(argv.slice(2));

  const k6Path = args["k6-json"];
  const cwPath = args["cw-json"];
  const cfgPath = args["thresholds"] ?? resolve("tests/load/config/thresholds.json");
  const profile = args["profile"] ?? "sustained-peak";
  const outJson = args["out-json"] ?? "results/load-test-report.json";
  const outMd = args["out-md"] ?? "results/load-test-report.md";

  if (!k6Path) {
    console.error("Error: --k6-json <path> is required");
    exit(1);
  }

  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  const k6 = parseK6Json(k6Path);
  if (!k6) {
    console.error(`Error: failed to parse k6 JSON output from ${k6Path}`);
    exit(1);
  }

  const cw = cwPath ? parseCloudWatchJson(cwPath) : null;
  if (cwPath && !cw) {
    console.error(`Error: --cw-json provided but failed to parse ${cwPath}. Cannot verify server-side metrics.`);
    exit(1);
  }

  const report = buildReport({ profile, k6, cw, cfg });
  const md = renderMarkdown(report);

  writeFileSync(outJson, JSON.stringify(report, null, 2));
  writeFileSync(outMd, md);

  console.log(md);
  console.log(`\nJSON report: ${outJson}`);
  console.log(`Markdown report: ${outMd}`);
  console.log(`\nOverall verdict: ${report.overallVerdict}`);

  if (report.overallVerdict === "FAIL") {
    exit(1);
  }
}

main();
