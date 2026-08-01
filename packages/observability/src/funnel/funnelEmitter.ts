/**
 * FunnelPort + buffered FunnelEmitter (WO-106 AC2, AC3, AC9).
 *
 * Design:
 *   - FunnelPort interface is the only write path; domain services never
 *     import Prisma or the CloudWatch SDK directly.
 *   - FunnelEmitter is a bounded ring-buffer with a configurable flush interval
 *     and a drop-oldest overflow policy so a slow store can never block a request
 *     or exhaust memory.
 *   - emit() returns immediately (fire-and-forget from the caller's perspective).
 *   - The emitter flushes on an interval and on process SIGTERM for graceful ECS
 *     task shutdown.
 *   - A heartbeat metric is published every flush interval so a silent emitter
 *     failure raises an alarm rather than reading as a healthy zero.
 *   - Store failures are caught, logged at warn level, and counted — they never
 *     propagate to the HTTP response.
 *   - Schema validation failures at emission time drop the event and increment
 *     a validation-failure counter; malformed telemetry cannot poison the store.
 */

import type { FunnelEvent } from "@travel/contracts";
import { FunnelEventSchema } from "@travel/contracts";

// ---------------------------------------------------------------------------
// FunnelPort — the only write path (AC2)
// ---------------------------------------------------------------------------

export interface FunnelPort {
  /**
   * Enqueue a funnel event for asynchronous persistence.
   * Returns immediately — does NOT await any store write.
   */
  emit(event: FunnelEvent): void;

  /**
   * Flush all buffered events to the store and reset the buffer.
   * Awaitable for graceful shutdown.
   */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store and EMF writer ports (injected by adapter implementations)
// ---------------------------------------------------------------------------

export interface FunnelStorePort {
  insertBatch(events: FunnelEvent[]): Promise<void>;
}

export interface FunnelEmfWriterPort {
  writeBatch(events: FunnelEvent[]): void;
}

// ---------------------------------------------------------------------------
// FunnelEmitterConfig
// ---------------------------------------------------------------------------

export interface FunnelEmitterConfig {
  /** Maximum events held in the ring buffer before oldest are dropped. Default 500. */
  maxBufferSize?: number;
  /** Milliseconds between automatic flushes. Default 2 000. */
  flushIntervalMs?: number;
  /** Milliseconds between heartbeat metric emissions. Default = flushIntervalMs. */
  heartbeatIntervalMs?: number;
  /** Logger function for warnings (defaults to console.warn). */
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Logger function for errors (defaults to console.error). */
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// FunnelEmitter
// ---------------------------------------------------------------------------

export class FunnelEmitter implements FunnelPort {
  private readonly _buffer: FunnelEvent[] = [];
  private readonly _maxBufferSize: number;
  private readonly _store: FunnelStorePort;
  private readonly _emfWriter: FunnelEmfWriterPort;
  private readonly _warn: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly _error: (msg: string, meta?: Record<string, unknown>) => void;

  private _droppedEvents = 0;
  private _emissionFailures = 0;
  private _validationFailures = 0;
  private _flushTimer: ReturnType<typeof setInterval> | undefined;
  private _heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private _isFlushing = false;
  private _sigtermBound = false;

  constructor(
    store: FunnelStorePort,
    emfWriter: FunnelEmfWriterPort,
    config: FunnelEmitterConfig = {},
  ) {
    this._store = store;
    this._emfWriter = emfWriter;
    this._maxBufferSize = config.maxBufferSize ?? 500;
    this._warn = config.warn ?? ((msg, meta) => console.warn("[funnel]", msg, meta));
    this._error = config.error ?? ((msg, meta) => console.error("[funnel]", msg, meta));

    const flushMs = config.flushIntervalMs ?? 2_000;
    const heartbeatMs = config.heartbeatIntervalMs ?? flushMs;

    this._flushTimer = setInterval(() => {
      this.flush().catch((err: unknown) => {
        this._error("flush-interval error", { err: String(err) });
      });
    }, flushMs);
    // Don't block Node process exit
    if (this._flushTimer.unref) this._flushTimer.unref();

    this._heartbeatTimer = setInterval(() => {
      this._emitHeartbeat();
    }, heartbeatMs);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();

    // Flush on graceful SIGTERM (ECS task shutdown)
    if (!this._sigtermBound) {
      this._sigtermBound = true;
      process.once("SIGTERM", () => {
        this.flush().catch(() => {});
      });
    }
  }

  /**
   * Validate and enqueue a funnel event.
   * Returns immediately to the caller.
   */
  emit(event: FunnelEvent): void {
    const parsed = FunnelEventSchema.safeParse(event);
    if (!parsed.success) {
      this._validationFailures++;
      this._warn("funnel event failed schema validation — dropped", {
        eventType: (event as Partial<FunnelEvent>).eventType,
        issues: parsed.error.issues.map((i) => i.message).join("; "),
      });
      this._emitValidationFailureMetric();
      return;
    }

    if (this._buffer.length >= this._maxBufferSize) {
      // Drop oldest event (ring-buffer overflow)
      this._buffer.shift();
      this._droppedEvents++;
      this._emitDroppedMetric();
    }

    this._buffer.push(parsed.data);
  }

  /**
   * Flush all buffered events to the store and emit EMF counters.
   * Idempotent when the buffer is empty.
   */
  async flush(): Promise<void> {
    if (this._isFlushing || this._buffer.length === 0) return;
    this._isFlushing = true;

    const batch = this._buffer.splice(0, this._buffer.length);

    try {
      await this._store.insertBatch(batch);
      this._emfWriter.writeBatch(batch);
    } catch (err: unknown) {
      this._emissionFailures++;
      this._warn("funnel store flush failed — events re-queued", {
        batchSize: batch.length,
        err: String(err),
      });
      this._emitEmissionFailureMetric(batch.length);
      // Re-queue with drop-oldest if buffer is full
      for (const ev of batch) {
        if (this._buffer.length >= this._maxBufferSize) {
          this._buffer.shift();
          this._droppedEvents++;
        }
        this._buffer.unshift(ev);
      }
    } finally {
      this._isFlushing = false;
    }
  }

  /** Stop background timers (for clean teardown in tests). */
  destroy(): void {
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
  }

  get droppedEventsCount(): number { return this._droppedEvents; }
  get emissionFailuresCount(): number { return this._emissionFailures; }
  get validationFailuresCount(): number { return this._validationFailures; }
  get bufferSize(): number { return this._buffer.length; }

  // ---------------------------------------------------------------------------
  // EMF metric helpers
  // ---------------------------------------------------------------------------

  private _emitHeartbeat(): void {
    emitEmf("travel/funnel", { funnel_emitter_heartbeat: 1 }, { environment: getEnv() });
  }

  private _emitDroppedMetric(): void {
    emitEmf("travel/funnel", { funnel_events_dropped_total: 1 }, { environment: getEnv() });
  }

  private _emitEmissionFailureMetric(batchSize: number): void {
    emitEmf("travel/funnel", { funnel_emission_failed_total: batchSize }, { environment: getEnv() });
  }

  private _emitValidationFailureMetric(): void {
    emitEmf("travel/funnel", { funnel_validation_failures_total: 1 }, { environment: getEnv() });
  }
}

// ---------------------------------------------------------------------------
// NOOP emitter — for use in tests that do not need funnel telemetry
// ---------------------------------------------------------------------------

export const NOOP_FUNNEL_EMITTER: FunnelPort = {
  emit: () => {},
  flush: async () => {},
};

// ---------------------------------------------------------------------------
// EMF helpers
// ---------------------------------------------------------------------------

function emitEmf(
  namespace: string,
  metrics: Record<string, number>,
  dimensions: Record<string, string> = {},
): void {
  const metricDefs = Object.keys(metrics).map((name) => ({ Name: name, Unit: "Count" }));
  const line = JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: metricDefs,
        },
      ],
    },
    ...dimensions,
    ...metrics,
  });
  process.stdout.write(line + "\n");
}

function getEnv(): string {
  return process.env["NODE_ENV"] ?? "unknown";
}
