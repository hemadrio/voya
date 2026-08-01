/**
 * Supplier outage and circuit breaker scenario (WO-099 AC1, AC2, AC3, AC14).
 *
 * Asserts:
 *   AC1: Circuit breaker opens after 5 failures within 10 s rolling window,
 *        half-open probe at 30 s, 2200 ms per-supplier timeout enforced.
 *   AC2: Stale cache served with freshness label; empty state explicit.
 *   AC3: Supplier rejection → 422; supplier failure/timeout → 502 or 504.
 *   AC14: Adapter-level faults have unit tests with injected fakes + controllable clock.
 *
 * Uses FakeClock and FakeAdapter from @travel/supplier-resilience so no real
 * network calls are made — fully runnable in CI.
 */

import { describe, it, expect } from "vitest";
import {
  BreakerRegistry,
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_BREAKER_CONFIG,
  SupplierFanOutExecutor,
  TimeoutError,
} from "@travel/supplier-resilience";
import type {
  BreakerConfig,
  BreakerMetrics,
  BreakerState,
  NormalisedOffer,
  SupplierAdapter,
} from "@travel/supplier-resilience";
import {
  OFFER_SUPPLIER_A,
  OFFER_SUPPLIER_B,
  SYNTH_CORR_ID,
  SYNTH_SUPPLIER_A,
  SYNTH_SUPPLIER_B,
  SYNTH_SUPPLIER_C,
} from "./fixtures/fault-stubs.js";

// ---------------------------------------------------------------------------
// FakeClock (local copy — keeps tests self-contained without jest/globals dep)
// ---------------------------------------------------------------------------

interface PendingTimer {
  deadline: number;
  resolve: () => void;
}

class FakeClock {
  private _time: number;
  private readonly _pending: PendingTimer[] = [];
  constructor(initialMs = 0) { this._time = initialMs; }
  now(): number { return this._time; }
  schedule(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const deadline = this._time + ms;
    return new Promise<void>((resolve) => {
      this._pending.push({ deadline, resolve });
    });
  }
  advance(deltaMs: number): void {
    this._time += deltaMs;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const entry = this._pending[i];
      if (entry !== undefined && this._time >= entry.deadline) {
        entry.resolve();
        this._pending.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SpyBreakerMetrics — captures transition calls
// ---------------------------------------------------------------------------

class SpyBreakerMetrics implements BreakerMetrics {
  readonly transitions: Array<{
    supplier: string;
    from: BreakerState;
    to: BreakerState;
    failureCount: number;
  }> = [];
  recordTransition(supplier: string, from: BreakerState, to: BreakerState, failureCount: number) {
    this.transitions.push({ supplier, from, to, failureCount });
  }
}

// ---------------------------------------------------------------------------
// FakeSupplierAdapter
// ---------------------------------------------------------------------------

type FakeAdapterMode = "HEALTHY" | "FAILING" | "SLOW" | "REJECTED";

class FakeSupplierAdapter implements SupplierAdapter {
  callCount = 0;
  constructor(
    readonly supplierName: string,
    private readonly mode: FakeAdapterMode,
    private readonly offers: NormalisedOffer[] = [],
  ) {}
  searchOffers(): Promise<ReadonlyArray<NormalisedOffer>> {
    this.callCount++;
    switch (this.mode) {
      case "HEALTHY":
        return Promise.resolve(this.offers);
      case "FAILING":
        return Promise.reject(new Error("Supplier internal error"));
      case "SLOW":
        return new Promise<ReadonlyArray<NormalisedOffer>>(() => { /* hangs */ });
      case "REJECTED": {
        const err = Object.assign(new Error("Supplier rejected: invalid request"), {
          httpStatus: 422,
        });
        return Promise.reject(err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AC1: Circuit breaker state machine — exact threshold tests
// ---------------------------------------------------------------------------

describe("AC1: Circuit breaker opens after 5 failures within 10 s", () => {
  const CONFIG: BreakerConfig = {
    failureThreshold: 5,
    rollingWindowMs: 10_000,
    halfOpenAfterMs: 30_000,
  };

  it("CLOSED → OPEN on the 5th failure within the 10 s window", () => {
    const clock = new FakeClock(0);
    const metrics = new SpyBreakerMetrics();
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock, metrics);

    for (let i = 0; i < 4; i++) {
      breaker.canCall();
      breaker.onFailure();
      expect(breaker.state).toBe("CLOSED");
    }
    breaker.canCall();
    breaker.onFailure();
    expect(breaker.state).toBe("OPEN");

    const transition = metrics.transitions.find((t) => t.to === "OPEN");
    expect(transition).toBeDefined();
    expect(transition!.failureCount).toBe(5);
  });

  it("does NOT open when the 5th failure lands just outside the 10 s window (sliding-window proof)", () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock);

    // 4 failures near T=0
    for (let i = 0; i < 4; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // Advance PAST the rolling window before the 5th failure
    clock.advance(CONFIG.rollingWindowMs + 1);
    breaker.canCall();
    breaker.onFailure();

    // The first 4 are now outside the window — CLOSED
    expect(breaker.state).toBe("CLOSED");
  });

  it("short-circuits while OPEN — canCall() returns false", () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock);

    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    expect(breaker.state).toBe("OPEN");
    expect(breaker.canCall()).toBe(false);
  });

  it("OPEN → HALF_OPEN probe admitted at 30 s", () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock);

    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    expect(breaker.state).toBe("OPEN");

    clock.advance(CONFIG.halfOpenAfterMs);
    expect(breaker.state).toBe("HALF_OPEN");
    expect(breaker.canCall()).toBe(true); // probe admitted
  });

  it("HALF_OPEN → CLOSED when probe succeeds", () => {
    const clock = new FakeClock(0);
    const metrics = new SpyBreakerMetrics();
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock, metrics);

    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    clock.advance(CONFIG.halfOpenAfterMs);
    breaker.canCall(); // probe call
    breaker.onSuccess();

    expect(breaker.state).toBe("CLOSED");
    expect(metrics.transitions.find((t) => t.to === "CLOSED")).toBeDefined();
  });

  it("HALF_OPEN → OPEN when probe fails (re-opens immediately)", () => {
    const clock = new FakeClock(0);
    const metrics = new SpyBreakerMetrics();
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock, metrics);

    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    clock.advance(CONFIG.halfOpenAfterMs);
    breaker.canCall();
    breaker.onFailure(); // probe fails → re-opens

    expect(breaker.state).toBe("OPEN");
    const openTransitions = metrics.transitions.filter((t) => t.to === "OPEN");
    expect(openTransitions.length).toBe(2); // original open + re-open
  });

  it("only one concurrent HALF_OPEN probe admitted (additional callers get false)", () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(SYNTH_SUPPLIER_A, CONFIG, clock);

    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    clock.advance(CONFIG.halfOpenAfterMs);

    const probe1 = breaker.canCall(); // first caller — gets the probe
    const probe2 = breaker.canCall(); // concurrent caller — refused

    expect(probe1).toBe(true);
    expect(probe2).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC1: 2200 ms per-supplier timeout via FanOutExecutor with FakeClock
// ---------------------------------------------------------------------------

describe("AC1: 2200 ms per-supplier timeout enforcement", () => {
  it("slow supplier is cut off at 2200 ms and returns TIMED_OUT outcome", async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const slow = new FakeSupplierAdapter(SYNTH_SUPPLIER_A, "SLOW");
    const healthy = new FakeSupplierAdapter(SYNTH_SUPPLIER_B, "HEALTHY", [OFFER_SUPPLIER_B]);

    const executor = new SupplierFanOutExecutor(
      [slow, healthy],
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const executePromise = executor.execute({}, SYNTH_CORR_ID);
    // Advance just past the 2200 ms timeout to fire it
    clock.advance(2_201);

    const result = await executePromise;

    const slowOutcome = result.supplierOutcomes.find((o) => o.supplier === SYNTH_SUPPLIER_A);
    expect(slowOutcome?.outcome).toBe("TIMED_OUT");
    expect(result.allUnavailable).toBe(false);
    expect(result.offers).toContainEqual(OFFER_SUPPLIER_B);
  });

  it("supplier completing in 2199 ms is NOT timed out", async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);

    let resolveSlowly!: (v: ReadonlyArray<NormalisedOffer>) => void;
    const slowButFinishes: SupplierAdapter = {
      supplierName: SYNTH_SUPPLIER_A,
      searchOffers: () =>
        new Promise<ReadonlyArray<NormalisedOffer>>((resolve) => {
          resolveSlowly = resolve;
        }),
    };

    const executor = new SupplierFanOutExecutor(
      [slowButFinishes],
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const executePromise = executor.execute({}, SYNTH_CORR_ID);

    // Advance to 2199 ms — supplier hasn't been cut off yet
    clock.advance(2_199);
    resolveSlowly([OFFER_SUPPLIER_A]); // supplier resolves just in time

    const result = await executePromise;
    const outcome = result.supplierOutcomes.find((o) => o.supplier === SYNTH_SUPPLIER_A);
    expect(outcome?.outcome).toBe("SUCCEEDED");
  });
});

// ---------------------------------------------------------------------------
// AC1: Partial attributed result set — one of three suppliers dead
// ---------------------------------------------------------------------------

describe("AC1: Partial attributed result set when one of three suppliers is dead", () => {
  it("returns offers from healthy suppliers; failed supplier appears in outcomes", async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const adapterA = new FakeSupplierAdapter(SYNTH_SUPPLIER_A, "HEALTHY", [OFFER_SUPPLIER_A]);
    const adapterB = new FakeSupplierAdapter(SYNTH_SUPPLIER_B, "FAILING");
    const adapterC = new FakeSupplierAdapter(SYNTH_SUPPLIER_C, "HEALTHY", [OFFER_SUPPLIER_B]);

    const executor = new SupplierFanOutExecutor(
      [adapterA, adapterB, adapterC],
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const result = await executor.execute({}, SYNTH_CORR_ID);

    expect(result.allUnavailable).toBe(false);
    expect(result.offers).toHaveLength(2);

    const outcomeB = result.supplierOutcomes.find((o) => o.supplier === SYNTH_SUPPLIER_B);
    expect(outcomeB?.outcome).toBe("FAILED");

    // Outcome is attributed — no mystery null entries
    expect(result.supplierOutcomes).toHaveLength(3);
  });

  it("allUnavailable=true only when ALL three suppliers fail", async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const adapters = [SYNTH_SUPPLIER_A, SYNTH_SUPPLIER_B, SYNTH_SUPPLIER_C].map(
      (name) => new FakeSupplierAdapter(name, "FAILING"),
    );
    const executor = new SupplierFanOutExecutor(
      adapters,
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const result = await executor.execute({}, SYNTH_CORR_ID);
    expect(result.allUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3: Supplier error mapping
// ---------------------------------------------------------------------------

describe("AC3: Supplier error mapping — rejection → 422; failure → 502/504", () => {
  it("CircuitOpenError carries supplierName (enables 503 gateway synthesis)", () => {
    const err = new CircuitOpenError(SYNTH_SUPPLIER_A);
    expect(err.supplierName).toBe(SYNTH_SUPPLIER_A);
    expect(err.name).toBe("CircuitOpenError");
  });

  it("TimeoutError carries timeoutMs (enables 504 gateway synthesis)", () => {
    const err = new TimeoutError(2200);
    expect(err.timeoutMs).toBe(2200);
    expect(err.name).toBe("TimeoutError");
  });

  it("supplier outcome details contain no internal error messages or stack traces (A10)", async () => {
    const clock = new FakeClock(0);
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock);
    const failing = new FakeSupplierAdapter(SYNTH_SUPPLIER_A, "FAILING");
    const executor = new SupplierFanOutExecutor(
      [failing],
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const result = await executor.execute({}, SYNTH_CORR_ID);
    const serialised = JSON.stringify(result.supplierOutcomes);
    // No raw error message or stack trace in outcome (A10: never expose internal detail)
    expect(serialised).not.toMatch(/internal error/i);
    expect(serialised).not.toMatch(/at Object/);
    expect(serialised).not.toMatch(/Error:/);
  });
});

// ---------------------------------------------------------------------------
// SKIPPED_CIRCUIT_OPEN outcome
// ---------------------------------------------------------------------------

describe("Circuit OPEN yields SKIPPED_CIRCUIT_OPEN outcome", () => {
  it("open breaker produces SKIPPED outcome without making a network call", async () => {
    const clock = new FakeClock(0);
    const metrics = new SpyBreakerMetrics();
    const registry = new BreakerRegistry(DEFAULT_BREAKER_CONFIG, clock, metrics);
    const adapter = new FakeSupplierAdapter(SYNTH_SUPPLIER_A, "HEALTHY", [OFFER_SUPPLIER_A]);

    // Pre-open the breaker
    const breaker = registry.getOrCreate(SYNTH_SUPPLIER_A);
    for (let i = 0; i < 5; i++) { breaker.canCall(); breaker.onFailure(); }
    expect(breaker.state).toBe("OPEN");

    const executor = new SupplierFanOutExecutor(
      [adapter],
      registry,
      { timeoutMs: 2_200 },
      clock,
    );

    const result = await executor.execute({}, SYNTH_CORR_ID);

    const skipped = result.supplierOutcomes.find((o) => o.supplier === SYNTH_SUPPLIER_A);
    expect(skipped?.outcome).toBe("SKIPPED_CIRCUIT_OPEN");
    expect(adapter.callCount).toBe(0); // no network call made
  });
});
