import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import type {
  BreakerMetrics,
  BreakerState,
  FanOutMetrics,
  SupplierCallOutcome,
} from './types.js';

// ---------------------------------------------------------------------------
// OTel counters — initialised lazily via factory to keep module-level state
// minimal and allow the SDK to be registered before first use.
// ---------------------------------------------------------------------------

let _breakerCounter: Counter | null = null;
let _callCounter: Counter | null = null;

function getBreakingCounter(): Counter {
  if (_breakerCounter === null) {
    const meter = metrics.getMeter('@travel/supplier-resilience');
    _breakerCounter = meter.createCounter('supplier_breaker_transitions_total', {
      description: 'Total circuit breaker state transitions by supplier',
    });
  }
  return _breakerCounter;
}

function getCallCounter(): Counter {
  if (_callCounter === null) {
    const meter = metrics.getMeter('@travel/supplier-resilience');
    _callCounter = meter.createCounter('supplier_call_outcomes_total', {
      description: 'Total supplier call outcomes by supplier and outcome',
    });
  }
  return _callCounter;
}

// ---------------------------------------------------------------------------
// OTel-backed implementations
// ---------------------------------------------------------------------------

/**
 * Creates a BreakerMetrics implementation backed by an OTel counter.
 * Safe to call when no metrics provider is registered — the OTel API no-ops.
 */
export function createOtelBreakerMetrics(): BreakerMetrics {
  return {
    recordTransition(
      supplier: string,
      from: BreakerState,
      to: BreakerState,
      _failureCount: number,
    ): void {
      getBreakingCounter().add(1, {
        supplier,
        from_state: from,
        to_state: to,
      });
    },
  };
}

/**
 * Creates a FanOutMetrics implementation backed by an OTel counter.
 * Safe to call when no metrics provider is registered — the OTel API no-ops.
 */
export function createOtelFanOutMetrics(): FanOutMetrics {
  return {
    recordCallOutcome(supplier: string, outcome: SupplierCallOutcome): void {
      getCallCounter().add(1, { supplier, outcome });
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers — package-internal, re-exported from index for test consumers
// ---------------------------------------------------------------------------

/** Records all emissions for assertion in unit tests. */
export class SpyBreakerMetrics implements BreakerMetrics {
  readonly transitions: Array<{
    supplier: string;
    from: BreakerState;
    to: BreakerState;
    failureCount: number;
  }> = [];

  recordTransition(
    supplier: string,
    from: BreakerState,
    to: BreakerState,
    failureCount: number,
  ): void {
    this.transitions.push({ supplier, from, to, failureCount });
  }

  reset(): void {
    this.transitions.length = 0;
  }
}

/** Records all call outcome emissions for assertion in unit tests. */
export class SpyFanOutMetrics implements FanOutMetrics {
  readonly outcomes: Array<{ supplier: string; outcome: SupplierCallOutcome }> = [];

  recordCallOutcome(supplier: string, outcome: SupplierCallOutcome): void {
    this.outcomes.push({ supplier, outcome });
  }

  reset(): void {
    this.outcomes.length = 0;
  }
}
