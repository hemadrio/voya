// ---------------------------------------------------------------------------
// Clock abstraction — all timing logic is clock-injected for testability
// ---------------------------------------------------------------------------

export interface Clock {
  /** Returns the current time in milliseconds since epoch. */
  now(): number;
  /**
   * Returns a Promise that resolves after `ms` milliseconds.
   * Tests inject a FakeClock whose schedule() resolves only when advance() is
   * called past the deadline, avoiding any real waiting.
   */
  schedule(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  schedule(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker types
// ---------------------------------------------------------------------------

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerConfig {
  /** Number of failures within rollingWindowMs that trip the breaker. */
  failureThreshold: number;
  /** Rolling window duration in milliseconds. */
  rollingWindowMs: number;
  /** How long to wait in OPEN before allowing a single probe (HALF_OPEN). */
  halfOpenAfterMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  rollingWindowMs: 10_000,
  halfOpenAfterMs: 30_000,
};

// ---------------------------------------------------------------------------
// Offer and adapter types
// ---------------------------------------------------------------------------

/** Minimal normalised offer returned by supplier adapters. */
export interface NormalisedOffer {
  readonly offerId: string;
  readonly supplierName: string;
  readonly price: { readonly amount: number; readonly currency: string };
  readonly vertical: 'flight' | 'hotel' | 'car';
}

/** Generic supplier adapter interface — call criteria is kept as unknown so the
 *  resilience package remains decoupled from specific search contracts. */
export interface SupplierAdapter {
  readonly supplierName: string;
  searchOffers(
    criteria: unknown,
    correlationId: string,
  ): Promise<ReadonlyArray<NormalisedOffer>>;
}

// ---------------------------------------------------------------------------
// Fan-out result types
// ---------------------------------------------------------------------------

export type SupplierCallOutcome =
  | 'SUCCEEDED'
  | 'TIMED_OUT'
  | 'FAILED'
  | 'SKIPPED_CIRCUIT_OPEN';

export interface SupplierOutcomeEntry {
  readonly supplier: string;
  readonly outcome: SupplierCallOutcome;
}

export interface FanOutResult {
  readonly offers: NormalisedOffer[];
  readonly supplierOutcomes: SupplierOutcomeEntry[];
  /** True when every supplier failed, timed out, or was skipped — no offers returned. */
  readonly allUnavailable: boolean;
}

export interface FanOutConfig {
  /** Per-supplier timeout in milliseconds. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Logger interface (matches Pino signature subset)
// ---------------------------------------------------------------------------

export interface ResilienceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Metrics interfaces — injected so tests can capture emissions
// ---------------------------------------------------------------------------

export interface BreakerMetrics {
  recordTransition(
    supplier: string,
    from: BreakerState,
    to: BreakerState,
    failureCount: number,
  ): void;
}

export interface FanOutMetrics {
  recordCallOutcome(supplier: string, outcome: SupplierCallOutcome): void;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CircuitOpenError extends Error {
  readonly supplierName: string;
  constructor(supplierName: string) {
    super(`Circuit breaker open for supplier: ${supplierName}`);
    this.name = 'CircuitOpenError';
    this.supplierName = supplierName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Supplier call timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
