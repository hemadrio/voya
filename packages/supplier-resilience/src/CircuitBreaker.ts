import type {
  BreakerConfig,
  BreakerMetrics,
  BreakerState,
  Clock,
  ResilienceLogger,
} from './types.js';

/**
 * Per-supplier circuit breaker state machine.
 *
 * State transitions:
 *   CLOSED  → OPEN      : rolling-window failure count reaches failureThreshold
 *   OPEN    → HALF_OPEN : halfOpenAfterMs has elapsed since opening (lazy, checked on canCall)
 *   HALF_OPEN → CLOSED  : probe call succeeds (onSuccess)
 *   HALF_OPEN → OPEN    : probe call fails  (onFailure)
 *
 * Exactly one concurrent call is admitted while HALF_OPEN; additional concurrent
 * callers receive canCall()=false (equivalent to OPEN) until the probe settles.
 *
 * All timing uses the injected Clock so tests need no real sleeps.
 */
export class CircuitBreaker {
  private _state: BreakerState = 'CLOSED';
  /** Timestamps (ms) of recent failures within the rolling window. */
  private _failureTimestamps: number[] = [];
  /** When the breaker last transitioned to OPEN (null when CLOSED). */
  private _lastOpenedAt: number | null = null;
  /** Whether a HALF_OPEN probe is currently in flight. */
  private _halfOpenProbeInFlight = false;

  constructor(
    readonly supplierName: string,
    private readonly config: BreakerConfig,
    private readonly clock: Clock,
    private readonly metrics?: BreakerMetrics,
    private readonly logger?: ResilienceLogger,
  ) {}

  get state(): BreakerState {
    // Lazily check for OPEN → HALF_OPEN transition on read
    this._maybeTransitionToHalfOpen();
    return this._state;
  }

  /**
   * Returns true if the call should be allowed through.
   *
   * For HALF_OPEN: atomically admits at most one probe. Concurrent callers while
   * a probe is in-flight receive false.
   *
   * Callers MUST call onSuccess() or onFailure() after canCall() returns true,
   * to correctly advance the state machine.
   */
  canCall(): boolean {
    this._maybeTransitionToHalfOpen();

    if (this._state === 'CLOSED') return true;

    if (this._state === 'HALF_OPEN') {
      if (this._halfOpenProbeInFlight) return false;
      // Atomically admit the single probe
      this._halfOpenProbeInFlight = true;
      return true;
    }

    // OPEN
    return false;
  }

  /** Called after a successful supplier call. */
  onSuccess(): void {
    if (this._state === 'HALF_OPEN') {
      this._halfOpenProbeInFlight = false;
      this._transitionTo('CLOSED');
    }
    // CLOSED: success is normal; no state change needed.
  }

  /**
   * Called after a failed supplier call (any error, including timeout).
   *
   * In CLOSED: adds to rolling window; trips to OPEN at threshold.
   * In HALF_OPEN: probe failed; reopens immediately.
   * In OPEN: no-op (should not be called, but safe).
   */
  onFailure(): void {
    if (this._state === 'HALF_OPEN') {
      this._halfOpenProbeInFlight = false;
      this._transitionTo('OPEN');
      return;
    }

    if (this._state === 'CLOSED') {
      const now = this.clock.now();
      this._failureTimestamps.push(now);
      // Prune timestamps outside the rolling window
      const cutoff = now - this.config.rollingWindowMs;
      this._failureTimestamps = this._failureTimestamps.filter(t => t > cutoff);

      if (this._failureTimestamps.length >= this.config.failureThreshold) {
        this._transitionTo('OPEN');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _maybeTransitionToHalfOpen(): void {
    if (
      this._state === 'OPEN' &&
      this._lastOpenedAt !== null &&
      this.clock.now() - this._lastOpenedAt >= this.config.halfOpenAfterMs
    ) {
      this._transitionTo('HALF_OPEN');
    }
  }

  private _transitionTo(next: BreakerState): void {
    const prev = this._state;
    if (prev === next) return;

    // Capture before clearing so the metric/log reflects the count that caused the trip
    const failureCount = this._failureTimestamps.length;

    this._state = next;

    if (next === 'OPEN') {
      this._lastOpenedAt = this.clock.now();
      this._failureTimestamps = [];
    } else if (next === 'CLOSED') {
      this._failureTimestamps = [];
      this._lastOpenedAt = null;
      this._halfOpenProbeInFlight = false;
    } else {
      // HALF_OPEN
      this._halfOpenProbeInFlight = false;
    }

    this.metrics?.recordTransition(this.supplierName, prev, next, failureCount);

    const level = next === 'OPEN' ? 'error' : 'warn';
    this.logger?.[level](
      {
        supplier: this.supplierName,
        previousState: prev,
        newState: next,
        failureCount,
      },
      `Circuit breaker transition: ${prev} → ${next}`,
    );
  }
}
