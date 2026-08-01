/**
 * StdoutEmfWriter — CloudWatch Embedded Metric Format adapter (WO-106 AC8).
 *
 * Emits one EMF JSON line per event type/category combination from a batch.
 * Dimension sets are restricted to eventType, category, and environment to
 * control CloudWatch custom-metric cost against the ~USD 2.4k/month budget.
 *
 * Constraints:
 *   - No user id, session id, correlation id, or trace id may appear as a
 *     CloudWatch dimension (low-cardinality policy).
 *   - The heartbeat metric is handled by FunnelEmitter itself so this writer
 *     only handles per-event-type counters from flush batches.
 */

import type { FunnelEvent } from "@travel/contracts";
import type { FunnelEmfWriterPort } from "./funnelEmitter.js";

export class StdoutEmfWriter implements FunnelEmfWriterPort {
  private readonly _environment: string;

  constructor(environment?: string) {
    this._environment = environment ?? process.env["NODE_ENV"] ?? "unknown";
  }

  writeBatch(events: FunnelEvent[]): void {
    if (events.length === 0) return;

    // Aggregate counts per (eventType, category) to minimise EMF lines.
    const counts = new Map<string, number>();
    for (const ev of events) {
      const key = `${ev.eventType}::${ev.category}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of counts) {
      const [eventType, category] = key.split("::");
      if (!eventType || !category) continue;

      const dimensions = {
        eventType,
        category,
        environment: this._environment,
      };

      const emf = {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "travel/funnel",
              Dimensions: [["eventType", "category", "environment"]],
              Metrics: [{ Name: "funnel_events_total", Unit: "Count" }],
            },
          ],
        },
        ...dimensions,
        funnel_events_total: count,
      };

      process.stdout.write(JSON.stringify(emf) + "\n");
    }
  }
}
