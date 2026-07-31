import { CircuitBreaker } from './CircuitBreaker.js';
import type {
  BreakerConfig,
  BreakerMetrics,
  Clock,
  ResilienceLogger,
} from './types.js';

/**
 * Registry that holds one CircuitBreaker instance per supplier name.
 *
 * Inject a fresh BreakerRegistry per test to guarantee isolated, clean state.
 * No module-level mutable singleton exists in this package.
 */
export class BreakerRegistry {
  private readonly _breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly defaultConfig: BreakerConfig,
    private readonly clock: Clock,
    private readonly metrics?: BreakerMetrics,
    private readonly logger?: ResilienceLogger,
  ) {}

  /**
   * Returns the breaker for supplierName, creating it with defaultConfig
   * (optionally overridden) on first access.
   */
  getOrCreate(supplierName: string, configOverride?: Partial<BreakerConfig>): CircuitBreaker {
    const existing = this._breakers.get(supplierName);
    if (existing !== undefined) return existing;

    const config: BreakerConfig = configOverride !== undefined
      ? { ...this.defaultConfig, ...configOverride }
      : this.defaultConfig;

    const breaker = new CircuitBreaker(
      supplierName,
      config,
      this.clock,
      this.metrics,
      this.logger,
    );
    this._breakers.set(supplierName, breaker);
    return breaker;
  }

  /** Returns an existing breaker without creating one. */
  get(supplierName: string): CircuitBreaker | undefined {
    return this._breakers.get(supplierName);
  }

  /** Removes a specific supplier's breaker (or all if omitted). Useful in tests. */
  reset(supplierName?: string): void {
    if (supplierName !== undefined) {
      this._breakers.delete(supplierName);
    } else {
      this._breakers.clear();
    }
  }

  get size(): number {
    return this._breakers.size;
  }
}
