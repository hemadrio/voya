/**
 * Integration test: wires the executor to three fake adapters and asserts
 * attributed partial results.  No real network or Redis dependency.
 *
 * Three adapters:
 *   healthy  — resolves immediately with two offers
 *   slow     — never resolves (cut off by per-supplier timeout)
 *   failing  — rejects immediately
 */
import { describe, it, expect } from '@jest/globals';
import { BreakerRegistry } from '../../src/BreakerRegistry.js';
import { SpyBreakerMetrics, SpyFanOutMetrics } from '../../src/metrics.js';
import { DEFAULT_BREAKER_CONFIG } from '../../src/types.js';
import { SupplierFanOutExecutor } from '../../src/SupplierFanOutExecutor.js';
import { FakeAdapter } from '../fakes/FakeAdapter.js';
import { FakeClock } from '../fakes/FakeClock.js';
import { FLIGHT_OFFER_A, FLIGHT_OFFER_B } from '../fixtures/offerFixtures.js';

const FAN_OUT_TIMEOUT_MS = 2_200;
const CRITERIA = { kind: 'flight', origin: 'JFK', destination: 'LAX' };
const CORR_ID = 'integration-corr-1';

describe('Fan-out integration — three adapters (healthy, slow, failing)', () => {
  it('returns partial results with correct per-supplier outcomes', async () => {
    const clock = new FakeClock(0);
    const breakerMetrics = new SpyBreakerMetrics();
    const fanOutMetrics = new SpyFanOutMetrics();

    const healthy = new FakeAdapter('healthy-airline', 'HEALTHY', [FLIGHT_OFFER_A, FLIGHT_OFFER_B]);
    const slow = new FakeAdapter('slow-gds', 'SLOW');
    const failing = new FakeAdapter('failing-supplier', 'FAILING');

    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock, breakerMetrics);
    const executor = new SupplierFanOutExecutor(
      [healthy, slow, failing],
      registry,
      { timeoutMs: FAN_OUT_TIMEOUT_MS },
      clock,
      fanOutMetrics,
    );

    const resultPromise = executor.execute(CRITERIA, CORR_ID);

    // Advance clock past the per-supplier timeout to fire the deadline for slow-gds
    clock.advance(FAN_OUT_TIMEOUT_MS + 1);

    const result = await resultPromise;

    // Partial result — healthy succeeded
    expect(result.allUnavailable).toBe(false);
    expect(result.offers).toHaveLength(2);

    // Per-supplier outcomes
    const outcomeMap = Object.fromEntries(
      result.supplierOutcomes.map(o => [o.supplier, o.outcome]),
    );
    expect(outcomeMap['healthy-airline']).toBe('SUCCEEDED');
    expect(outcomeMap['slow-gds']).toBe('TIMED_OUT');
    expect(outcomeMap['failing-supplier']).toBe('FAILED');
  });

  it('does not include offers from timed-out or failed suppliers', async () => {
    const clock = new FakeClock(0);
    const healthy = new FakeAdapter('healthy-airline', 'HEALTHY', [FLIGHT_OFFER_A]);
    const slow = new FakeAdapter('slow-gds', 'SLOW');
    const failing = new FakeAdapter('failing-supplier', 'FAILING');

    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const executor = new SupplierFanOutExecutor(
      [healthy, slow, failing],
      registry,
      { timeoutMs: FAN_OUT_TIMEOUT_MS },
      clock,
    );

    const resultPromise = executor.execute(CRITERIA, CORR_ID);
    clock.advance(FAN_OUT_TIMEOUT_MS + 1);
    const result = await resultPromise;

    // Only the healthy offer
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.supplierName).toBe('healthy-airline');
  });

  it('emits OTel-compatible metrics for each outcome', async () => {
    const clock = new FakeClock(0);
    const fanOutMetrics = new SpyFanOutMetrics();
    const breakerMetrics = new SpyBreakerMetrics();

    const healthy = new FakeAdapter('healthy-airline', 'HEALTHY', [FLIGHT_OFFER_A]);
    const slow = new FakeAdapter('slow-gds', 'SLOW');
    const failing = new FakeAdapter('failing-supplier', 'FAILING');

    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock, breakerMetrics);
    const executor = new SupplierFanOutExecutor(
      [healthy, slow, failing],
      registry,
      { timeoutMs: FAN_OUT_TIMEOUT_MS },
      clock,
      fanOutMetrics,
    );

    const resultPromise = executor.execute(CRITERIA, CORR_ID);
    clock.advance(FAN_OUT_TIMEOUT_MS + 1);
    await resultPromise;

    expect(fanOutMetrics.outcomes).toContainEqual({ supplier: 'healthy-airline', outcome: 'SUCCEEDED' });
    expect(fanOutMetrics.outcomes).toContainEqual({ supplier: 'slow-gds', outcome: 'TIMED_OUT' });
    expect(fanOutMetrics.outcomes).toContainEqual({ supplier: 'failing-supplier', outcome: 'FAILED' });
  });

  it('returns allUnavailable=true when all three suppliers are unavailable', async () => {
    const clock = new FakeClock(0);
    const slow = new FakeAdapter('slow-gds', 'SLOW');
    const failing1 = new FakeAdapter('failing-a', 'FAILING');
    const failing2 = new FakeAdapter('failing-b', 'FAILING');

    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const executor = new SupplierFanOutExecutor(
      [slow, failing1, failing2],
      registry,
      { timeoutMs: FAN_OUT_TIMEOUT_MS },
      clock,
    );

    const resultPromise = executor.execute(CRITERIA, CORR_ID);
    clock.advance(FAN_OUT_TIMEOUT_MS + 1);
    const result = await resultPromise;

    expect(result.allUnavailable).toBe(true);
    expect(result.offers).toHaveLength(0);
  });

  it('trips the failing supplier breaker and skips it on the next search', async () => {
    const clock = new FakeClock(0);
    const failing = new FakeAdapter('auto-tripping', 'FAILING');
    const registry = new BreakerRegistry(
      { ...DEFAULT_BREAKER_CONFIG, failureThreshold: 3 },
      clock,
    );
    const executor = new SupplierFanOutExecutor(
      [failing],
      registry,
      { timeoutMs: FAN_OUT_TIMEOUT_MS },
      clock,
    );

    // First three executions trip the breaker (threshold=3)
    for (let i = 0; i < 3; i++) {
      await executor.execute(CRITERIA, `corr-${i}`);
    }

    expect(registry.get('auto-tripping')?.state).toBe('OPEN');

    // Fourth execution: breaker open, adapter not called
    failing.callCount = 0;
    const result = await executor.execute(CRITERIA, 'corr-4');

    expect(failing.callCount).toBe(0);
    expect(result.supplierOutcomes[0]?.outcome).toBe('SKIPPED_CIRCUIT_OPEN');
  });
});
