/**
 * SafetyMetrics — duck-typed OTel counter interface for safety telemetry
 * (WO-061, AC9).
 *
 * Counters:
 *   injection_detections   — labelled by pattern class (no user free text).
 *   refusals               — labelled by reason code.
 *   sanitiser_actions      — labelled by action kind.
 *
 * No user free text in labels or attribute values (AC9).
 *
 * The concrete implementation is wired at startup with the real OTel SDK.
 * Tests inject a no-op or spy implementation.
 */

// ---------------------------------------------------------------------------
// Minimal counter duck type — no @opentelemetry/api import in domain layer
// ---------------------------------------------------------------------------

export interface CounterLike {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface MeterLike {
  createCounter(name: string, options?: { description?: string }): CounterLike;
}

// ---------------------------------------------------------------------------
// SafetyMetrics
// ---------------------------------------------------------------------------

export interface SafetyMetricsConfig {
  meter: MeterLike;
}

export class SafetyMetrics {
  private readonly injectionDetections: CounterLike;
  private readonly refusalsCounter: CounterLike;
  private readonly sanitiserActionsCounter: CounterLike;

  constructor(config: SafetyMetricsConfig) {
    const { meter } = config;
    this.injectionDetections = meter.createCounter("injection_detections", {
      description: "Number of injection pattern detections by pattern class",
    });
    this.refusalsCounter = meter.createCounter("refusals", {
      description: "Number of assistant turn refusals by reason",
    });
    this.sanitiserActionsCounter = meter.createCounter("sanitiser_actions", {
      description: "Number of output sanitisation actions by kind",
    });
  }

  recordDetection(patternClass: string): void {
    // patternClass is an enum value — safe to use as label (no free text)
    this.injectionDetections.add(1, { pattern_class: patternClass });
  }

  recordRefusal(reason: string): void {
    // reason is an enum value — safe to use as label (no free text)
    this.refusalsCounter.add(1, { reason });
  }

  recordSanitiserAction(kind: string, count: number): void {
    // kind is an enum value — safe to use as label (no free text)
    this.sanitiserActionsCounter.add(count, { kind });
  }
}

// ---------------------------------------------------------------------------
// No-op implementation for tests / pre-startup
// ---------------------------------------------------------------------------

const noopCounter: CounterLike = { add: () => {} };
const noopMeter: MeterLike = { createCounter: () => noopCounter };

export const NOOP_SAFETY_METRICS = new SafetyMetrics({ meter: noopMeter });
