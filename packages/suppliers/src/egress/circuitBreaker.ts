/**
 * Simple circuit breaker implementing the CLOSED → OPEN → HALF_OPEN state
 * machine. Each supplier adapter gets one breaker instance.
 *
 * Default settings (per WO-015 and architecture.md):
 *   - failureThreshold: 5 failures
 *   - windowMs: 10 000 ms (10 seconds)
 *   - halfOpenAfterMs: 30 000 ms (30 seconds)
 *
 * The `now` function is injectable so tests can advance time without real
 * wall-clock delays.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of failures within windowMs that open the breaker. Default: 5. */
  failureThreshold?: number | undefined;
  /** Rolling window over which failures are counted (ms). Default: 10 000. */
  windowMs?: number | undefined;
  /** Time after opening before a probe request is allowed (ms). Default: 30 000. */
  halfOpenAfterMs?: number | undefined;
  /** Injected clock function. Default: Date.now. */
  now?: (() => number) | undefined;
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly halfOpenAfterMs: number;
  private readonly now: () => number;

  /** Timestamps (ms) of each failure recorded within the current window. */
  private failureTimestamps: number[] = [];
  /** Wall-clock time the breaker last transitioned to OPEN. */
  private openedAt: number | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.windowMs = options.windowMs ?? 10_000;
    this.halfOpenAfterMs = options.halfOpenAfterMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The current breaker state. */
  getState(): BreakerState {
    return this.state;
  }

  /**
   * Returns true when the breaker will allow the upcoming request.
   * Calling this may transition OPEN → HALF_OPEN if the probe window has elapsed.
   */
  canRequest(): boolean {
    const nowMs = this.now();

    switch (this.state) {
      case 'CLOSED':
        return true;

      case 'OPEN': {
        const openedAt = this.openedAt;
        if (openedAt !== null && nowMs - openedAt >= this.halfOpenAfterMs) {
          this.state = 'HALF_OPEN';
          return true;
        }
        return false;
      }

      case 'HALF_OPEN':
        // Allow exactly one probe. Further requests are blocked until success
        // or failure is recorded.
        return true;
    }
  }

  /**
   * Record a successful response. Transitions HALF_OPEN / OPEN → CLOSED and
   * resets the failure window.
   */
  recordSuccess(): void {
    this.state = 'CLOSED';
    this.failureTimestamps = [];
    this.openedAt = null;
  }

  /**
   * Record a failed response. May transition CLOSED → OPEN or HALF_OPEN → OPEN
   * if the failure threshold is exceeded within the window.
   */
  recordFailure(): void {
    const nowMs = this.now();

    // Prune failures outside the rolling window.
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => nowMs - t < this.windowMs,
    );
    this.failureTimestamps.push(nowMs);

    if (
      this.state === 'HALF_OPEN' ||
      this.failureTimestamps.length >= this.failureThreshold
    ) {
      this.state = 'OPEN';
      this.openedAt = nowMs;
    }
  }
}
