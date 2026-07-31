import type { BreakerRegistry } from './BreakerRegistry.js';
import type {
  Clock,
  FanOutConfig,
  FanOutMetrics,
  FanOutResult,
  NormalisedOffer,
  ResilienceLogger,
  SupplierAdapter,
  SupplierOutcomeEntry,
} from './types.js';
import { TimeoutError } from './types.js';

/**
 * Races `promise` against a clock-backed timeout.
 *
 * `clock.schedule(ms)` is evaluated synchronously so the timeout deadline is
 * registered before the first async suspension — this makes fake-clock tests
 * deterministic (advance() fires deadlines before any microtasks run).
 *
 * The late resolution of a supplier promise after the timeout fires is
 * naturally discarded by Promise.race semantics.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  clock: Clock,
): Promise<T> {
  const timeout: Promise<T> = clock.schedule(timeoutMs).then(() => {
    throw new TimeoutError(timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Executes all registered supplier adapters in parallel, applies per-supplier
 * circuit breakers and timeouts, and returns a fully attributed result.
 *
 * Guarantees:
 *  - Suppliers with open breakers are skipped without network calls.
 *  - allUnavailable is true when zero suppliers succeeded.
 *  - Supplier outcome objects contain only display names and outcome enum values
 *    (BR-13 / policy A10 — no internal error text, stack traces, or provider payloads).
 *  - Promise.allSettled is never abandoned; every adapter either responds,
 *    times out, or is skipped before execute() resolves.
 */
export class SupplierFanOutExecutor {
  constructor(
    private readonly adapters: SupplierAdapter[],
    private readonly registry: BreakerRegistry,
    private readonly config: FanOutConfig,
    private readonly clock: Clock,
    private readonly metrics?: FanOutMetrics,
    private readonly logger?: ResilienceLogger,
  ) {}

  async execute(criteria: unknown, correlationId: string): Promise<FanOutResult> {
    const outcomes: SupplierOutcomeEntry[] = [];
    const allOffers: NormalisedOffer[] = [];

    const tasks = this.adapters.map(adapter => this._callAdapter(
      adapter,
      criteria,
      correlationId,
      outcomes,
      allOffers,
    ));

    await Promise.allSettled(tasks);

    const allUnavailable = outcomes.length === 0 ||
      outcomes.every(o => o.outcome !== 'SUCCEEDED');

    return {
      offers: allOffers,
      supplierOutcomes: outcomes,
      allUnavailable,
    };
  }

  private async _callAdapter(
    adapter: SupplierAdapter,
    criteria: unknown,
    correlationId: string,
    outcomes: SupplierOutcomeEntry[],
    allOffers: NormalisedOffer[],
  ): Promise<void> {
    const breaker = this.registry.getOrCreate(adapter.supplierName);

    if (!breaker.canCall()) {
      outcomes.push({ supplier: adapter.supplierName, outcome: 'SKIPPED_CIRCUIT_OPEN' });
      this.metrics?.recordCallOutcome(adapter.supplierName, 'SKIPPED_CIRCUIT_OPEN');
      this.logger?.warn(
        { supplier: adapter.supplierName, correlationId },
        'Supplier skipped — circuit breaker open',
      );
      return;
    }

    try {
      // raceWithTimeout is called synchronously so the timeout deadline is
      // registered in the clock before this task suspends on the await.
      const result = await raceWithTimeout(
        adapter.searchOffers(criteria, correlationId),
        this.config.timeoutMs,
        this.clock,
      );

      breaker.onSuccess();
      outcomes.push({ supplier: adapter.supplierName, outcome: 'SUCCEEDED' });
      this.metrics?.recordCallOutcome(adapter.supplierName, 'SUCCEEDED');
      for (const offer of result) {
        allOffers.push(offer);
      }
    } catch (err: unknown) {
      breaker.onFailure();

      if (err instanceof TimeoutError) {
        outcomes.push({ supplier: adapter.supplierName, outcome: 'TIMED_OUT' });
        this.metrics?.recordCallOutcome(adapter.supplierName, 'TIMED_OUT');
        this.logger?.warn(
          { supplier: adapter.supplierName, correlationId, timeoutMs: this.config.timeoutMs },
          'Supplier call timed out',
        );
      } else {
        // Report only the outcome — never include internal error messages (BR-13)
        outcomes.push({ supplier: adapter.supplierName, outcome: 'FAILED' });
        this.metrics?.recordCallOutcome(adapter.supplierName, 'FAILED');
        this.logger?.error(
          { supplier: adapter.supplierName, correlationId },
          'Supplier call failed',
        );
      }
    }
  }
}
