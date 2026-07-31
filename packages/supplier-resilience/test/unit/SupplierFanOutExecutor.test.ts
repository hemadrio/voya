import { describe, it, expect } from '@jest/globals';
import { BreakerRegistry } from '../../src/BreakerRegistry.js';
import { SpyBreakerMetrics, SpyFanOutMetrics } from '../../src/metrics.js';
import { DEFAULT_BREAKER_CONFIG } from '../../src/types.js';
import { SupplierFanOutExecutor } from '../../src/SupplierFanOutExecutor.js';
import { FakeAdapter } from '../fakes/FakeAdapter.js';
import { FakeClock } from '../fakes/FakeClock.js';
import { FLIGHT_OFFER_A, FLIGHT_OFFER_B } from '../fixtures/offerFixtures.js';

const TIMEOUT_MS = 2_200;
const CRITERIA = { kind: 'flight' };
const CORR_ID = 'test-corr-1';

function makeExecutor(
  adapters: FakeAdapter[],
  clock: FakeClock,
  fanOutMetrics?: SpyFanOutMetrics,
  breakerMetrics?: SpyBreakerMetrics,
) {
  const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock, breakerMetrics);
  return new SupplierFanOutExecutor(adapters, registry, { timeoutMs: TIMEOUT_MS }, clock, fanOutMetrics);
}

// ---------------------------------------------------------------------------
// Partial results
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — partial results (some succeed)', () => {
  it('returns offers from the healthy adapter', async () => {
    const clock = new FakeClock(0);
    const healthy = new FakeAdapter('healthy', 'HEALTHY', [FLIGHT_OFFER_A, FLIGHT_OFFER_B]);
    const failing = new FakeAdapter('failing', 'FAILING');

    const executor = makeExecutor([healthy, failing], clock);

    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(result.offers).toHaveLength(2);
    expect(result.allUnavailable).toBe(false);
  });

  it('records SUCCEEDED and FAILED outcomes', async () => {
    const clock = new FakeClock(0);
    const healthy = new FakeAdapter('healthy', 'HEALTHY', [FLIGHT_OFFER_A]);
    const failing = new FakeAdapter('failing', 'FAILING');
    const spy = new SpyFanOutMetrics();
    const executor = makeExecutor([healthy, failing], clock, spy);

    await executor.execute(CRITERIA, CORR_ID);

    expect(spy.outcomes).toContainEqual({ supplier: 'healthy', outcome: 'SUCCEEDED' });
    expect(spy.outcomes).toContainEqual({ supplier: 'failing', outcome: 'FAILED' });
  });
});

// ---------------------------------------------------------------------------
// All suppliers fail
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — all-fail path', () => {
  it('sets allUnavailable=true when all suppliers fail', async () => {
    const clock = new FakeClock(0);
    const a = new FakeAdapter('a', 'FAILING');
    const b = new FakeAdapter('b', 'FAILING');

    const executor = makeExecutor([a, b], clock);
    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(result.offers).toHaveLength(0);
    expect(result.allUnavailable).toBe(true);
  });

  it('sets allUnavailable=true for a single failing supplier', async () => {
    const clock = new FakeClock(0);
    const only = new FakeAdapter('only', 'FAILING');

    const executor = makeExecutor([only], clock);
    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(result.allUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timeout path
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — timeout', () => {
  it('records TIMED_OUT for a slow adapter', async () => {
    const clock = new FakeClock(0);
    const slow = new FakeAdapter('slow', 'SLOW');
    const spy = new SpyFanOutMetrics();

    const executor = makeExecutor([slow], clock, spy);
    const resultPromise = executor.execute(CRITERIA, CORR_ID);

    // Advance past the timeout to fire the deadline
    clock.advance(TIMEOUT_MS + 1);
    const result = await resultPromise;

    expect(result.supplierOutcomes[0]?.outcome).toBe('TIMED_OUT');
    expect(result.allUnavailable).toBe(true);
    expect(spy.outcomes).toContainEqual({ supplier: 'slow', outcome: 'TIMED_OUT' });
  });

  it('does not include late results from the slow adapter', async () => {
    const clock = new FakeClock(0);
    const slow = new FakeAdapter('slow', 'SLOW');
    const healthy = new FakeAdapter('healthy', 'HEALTHY', [FLIGHT_OFFER_A]);

    const executor = makeExecutor([slow, healthy], clock);
    const resultPromise = executor.execute(CRITERIA, CORR_ID);
    clock.advance(TIMEOUT_MS + 1);
    const result = await resultPromise;

    // Only offers from healthy
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.supplierName).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// Skip-on-open path
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — SKIPPED_CIRCUIT_OPEN', () => {
  it('skips a supplier whose breaker is already open', async () => {
    const clock = new FakeClock(0);
    const failing = new FakeAdapter('tripped', 'FAILING');
    const spy = new SpyFanOutMetrics();

    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const executor = new SupplierFanOutExecutor(
      [failing],
      registry,
      { timeoutMs: TIMEOUT_MS },
      clock,
      spy,
    );

    // Trip the breaker
    const breaker = registry.getOrCreate('tripped');
    for (let i = 0; i < DEFAULT_BREAKER_CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // Now execute — should skip without calling adapter
    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(failing.callCount).toBe(0);
    expect(result.supplierOutcomes[0]?.outcome).toBe('SKIPPED_CIRCUIT_OPEN');
    expect(result.allUnavailable).toBe(true);
  });

  it('sets allUnavailable=true when all suppliers have open breakers', async () => {
    const clock = new FakeClock(0);
    const a = new FakeAdapter('a', 'FAILING');
    const b = new FakeAdapter('b', 'FAILING');
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);

    const breakerA = registry.getOrCreate('a');
    const breakerB = registry.getOrCreate('b');
    for (let i = 0; i < DEFAULT_BREAKER_CONFIG.failureThreshold; i++) {
      breakerA.canCall(); breakerA.onFailure();
      breakerB.canCall(); breakerB.onFailure();
    }

    const executor = new SupplierFanOutExecutor([a, b], registry, { timeoutMs: TIMEOUT_MS }, clock);
    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(a.callCount).toBe(0);
    expect(b.callCount).toBe(0);
    expect(result.allUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No adapters edge case
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — no adapters', () => {
  it('returns empty offers and allUnavailable=true when adapter list is empty', async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const executor = new SupplierFanOutExecutor([], registry, { timeoutMs: TIMEOUT_MS }, clock);

    const result = await executor.execute(CRITERIA, CORR_ID);

    expect(result.offers).toHaveLength(0);
    expect(result.supplierOutcomes).toHaveLength(0);
    expect(result.allUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Metric emission
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — metric emission', () => {
  it('emits metrics for all outcomes', async () => {
    const clock = new FakeClock(0);
    const healthy = new FakeAdapter('healthy', 'HEALTHY', [FLIGHT_OFFER_A]);
    const failing = new FakeAdapter('failing', 'FAILING');
    const slow = new FakeAdapter('slow', 'SLOW');
    const spy = new SpyFanOutMetrics();

    const executor = makeExecutor([healthy, failing, slow], clock, spy);
    const resultPromise = executor.execute(CRITERIA, CORR_ID);
    clock.advance(TIMEOUT_MS + 1);
    await resultPromise;

    const outcomes = spy.outcomes.map(o => o.outcome);
    expect(outcomes).toContain('SUCCEEDED');
    expect(outcomes).toContain('FAILED');
    expect(outcomes).toContain('TIMED_OUT');
  });
});

// ---------------------------------------------------------------------------
// Outcome reporting — no internal error details (BR-13)
// ---------------------------------------------------------------------------

describe('SupplierFanOutExecutor — BR-13 compliance', () => {
  it('outcome entries contain only supplier name and outcome enum, no error text', async () => {
    const clock = new FakeClock(0);
    const failing = new FakeAdapter('failing', 'FAILING');
    const executor = makeExecutor([failing], clock);

    const result = await executor.execute(CRITERIA, CORR_ID);

    for (const entry of result.supplierOutcomes) {
      const keys = Object.keys(entry);
      expect(keys).toEqual(expect.arrayContaining(['supplier', 'outcome']));
      expect(keys).not.toContain('error');
      expect(keys).not.toContain('message');
      expect(keys).not.toContain('stack');
    }
  });
});
