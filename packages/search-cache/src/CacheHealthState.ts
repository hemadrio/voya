/**
 * CacheHealthState — tracks Redis availability through consecutive operation failures
 * and recovers via a clock-driven probe interval.
 *
 * State machine:
 *   HEALTHY  → record consecutiveFailuresToDegrade failures → UNAVAILABLE
 *   UNAVAILABLE → shouldProbe() true → attempt probe via caller → recordSuccess() → HEALTHY
 *
 * Hysteresis: transitions require N consecutive failures to degrade; a single
 * successful probe recovers.  This prevents flapping on intermittent errors.
 */

export type CacheHealthStatus = 'HEALTHY' | 'UNAVAILABLE';

export interface CacheHealthConfig {
  /**
   * Number of consecutive operation failures required to transition to UNAVAILABLE.
   * Defaults to 3. Must be ≥ 1.
   */
  consecutiveFailuresToDegrade: number;
  /**
   * Milliseconds between recovery probe attempts while in UNAVAILABLE state.
   * Defaults to 30_000 (30 s).
   */
  recoveryProbeIntervalMs: number;
}

export const DEFAULT_HEALTH_CONFIG: CacheHealthConfig = {
  consecutiveFailuresToDegrade: 3,
  recoveryProbeIntervalMs: 30_000,
};

export class CacheHealthState {
  private status: CacheHealthStatus = 'HEALTHY';
  private consecutiveFailures = 0;
  private lastProbeAttemptMs = 0;

  constructor(
    private readonly config: CacheHealthConfig = DEFAULT_HEALTH_CONFIG,
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {}

  /** Returns true when the cache is considered operational. */
  isAvailable(): boolean {
    return this.status === 'HEALTHY';
  }

  getStatus(): CacheHealthStatus {
    return this.status;
  }

  /**
   * Called after every successful Redis operation.
   * Resets the failure counter and recovers to HEALTHY.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.status = 'HEALTHY';
  }

  /**
   * Called after every failed Redis operation.
   * Increments the failure counter; transitions to UNAVAILABLE once the
   * configured threshold is reached.
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.consecutiveFailuresToDegrade) {
      this.status = 'UNAVAILABLE';
    }
  }

  /**
   * Returns true when it is time to attempt a recovery probe.
   * Only meaningful in UNAVAILABLE state; always false when HEALTHY.
   */
  shouldProbe(): boolean {
    if (this.status === 'HEALTHY') return false;
    return this.clock.now() - this.lastProbeAttemptMs >= this.config.recoveryProbeIntervalMs;
  }

  /**
   * Marks the current moment as the last probe attempt time.
   * Must be called before initiating a probe so the interval resets
   * regardless of whether the probe succeeds or fails.
   */
  markProbeAttempt(): void {
    this.lastProbeAttemptMs = this.clock.now();
  }
}
