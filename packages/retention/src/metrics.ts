/**
 * Purge metrics — CloudWatch-compatible counters via OpenTelemetry API.
 *
 * The production implementation uses OTel; a SpyPurgeMetrics test double
 * is exported for unit tests.
 */

import type { PurgeMetrics } from "./types.js";

// ---------------------------------------------------------------------------
// OTel production implementation (injected via factory)
// ---------------------------------------------------------------------------

/**
 * Create a PurgeMetrics instance backed by OTel counters.
 * If @opentelemetry/api is unavailable, falls back to no-ops.
 */
export function createPurgeMetrics(): PurgeMetrics {
  let meter: ReturnType<typeof getMeter> | null = null;

  try {
    meter = getMeter();
  } catch {
    // OTel SDK not bootstrapped — no-op
  }

  const examinedCounter = meter?.createCounter("purge_rows_examined_total", {
    description: "Total rows examined for purge eligibility",
  });
  const purgedCounter = meter?.createCounter("purge_rows_purged_total", {
    description: "Total rows physically deleted or crypto-erased",
  });
  const keysDestroyedCounter = meter?.createCounter("purge_keys_destroyed_total", {
    description: "Total DEKs destroyed during crypto-erasure",
  });
  const failureCounter = meter?.createCounter("purge_category_failures_total", {
    description: "Number of category-level purge failures",
  });
  const runStartCounter = meter?.createCounter("purge_runs_started_total", {
    description: "Number of purge runs started",
  });
  const runCompleteCounter = meter?.createCounter("purge_runs_completed_total", {
    description: "Number of purge runs completed (dry or apply)",
  });
  const durationHistogram = meter?.createHistogram("purge_category_duration_ms", {
    description: "Duration in ms for each category's purge sweep",
    unit: "ms",
  });

  return {
    recordExamined(category, count) {
      examinedCounter?.add(count, { category });
    },
    recordPurged(category, count) {
      purgedCounter?.add(count, { category });
    },
    recordKeysDestroyed(category, count) {
      keysDestroyedCounter?.add(count, { category });
    },
    recordFailure(category) {
      failureCounter?.add(1, { category });
    },
    recordDuration(category, durationMs) {
      durationHistogram?.record(durationMs, { category });
    },
    recordRunStart() {
      runStartCounter?.add(1);
    },
    recordRunComplete(dryRun) {
      runCompleteCounter?.add(1, { dry_run: String(dryRun) });
    },
  };
}

// ---------------------------------------------------------------------------
// Spy implementation for unit tests
// ---------------------------------------------------------------------------

export class SpyPurgeMetrics implements PurgeMetrics {
  readonly examined: Array<{ category: string; count: number }> = [];
  readonly purged: Array<{ category: string; count: number }> = [];
  readonly keysDestroyed: Array<{ category: string; count: number }> = [];
  readonly failures: string[] = [];
  readonly durations: Array<{ category: string; durationMs: number }> = [];
  runStarts = 0;
  runCompletes: Array<{ dryRun: boolean }> = [];

  recordExamined(category: string, count: number) {
    this.examined.push({ category, count });
  }
  recordPurged(category: string, count: number) {
    this.purged.push({ category, count });
  }
  recordKeysDestroyed(category: string, count: number) {
    this.keysDestroyed.push({ category, count });
  }
  recordFailure(category: string) {
    this.failures.push(category);
  }
  recordDuration(category: string, durationMs: number) {
    this.durations.push({ category, durationMs });
  }
  recordRunStart() {
    this.runStarts++;
  }
  recordRunComplete(dryRun: boolean) {
    this.runCompletes.push({ dryRun });
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function getMeter() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { metrics } = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  return metrics.getMeter("travel.retention.purge", "1.0.0");
}
