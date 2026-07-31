import { describe, it, expect, jest } from '@jest/globals';
import { CircuitBreaker } from '../../src/CircuitBreaker.js';
import { SpyBreakerMetrics } from '../../src/metrics.js';
import type { BreakerConfig } from '../../src/types.js';
import { FakeClock } from '../fakes/FakeClock.js';

const SUPPLIER = 'test-supplier';

const CONFIG: BreakerConfig = {
  failureThreshold: 5,
  rollingWindowMs: 10_000,
  halfOpenAfterMs: 30_000,
};

function makeBreaker(metrics?: SpyBreakerMetrics, logger?: { warn: jest.Mock; error: jest.Mock }) {
  const clock = new FakeClock(0);
  const breaker = new CircuitBreaker(SUPPLIER, CONFIG, clock, metrics, logger);
  return { breaker, clock };
}

describe('CircuitBreaker — initial state', () => {
  it('starts CLOSED and allows calls', () => {
    const { breaker } = makeBreaker();
    expect(breaker.state).toBe('CLOSED');
    expect(breaker.canCall()).toBe(true);
  });
});

describe('CircuitBreaker — CLOSED → OPEN transition', () => {
  it('opens after exactly failureThreshold failures within the window', () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < CONFIG.failureThreshold - 1; i++) {
      breaker.canCall();
      breaker.onFailure();
      expect(breaker.state).toBe('CLOSED');
    }

    breaker.canCall();
    breaker.onFailure();
    expect(breaker.state).toBe('OPEN');
  });

  it('does NOT open when failures span more than rollingWindowMs', () => {
    const { breaker, clock } = makeBreaker();

    // 4 failures near time 0
    for (let i = 0; i < CONFIG.failureThreshold - 1; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // Advance past the rolling window before the 5th failure
    clock.advance(CONFIG.rollingWindowMs + 1);
    breaker.canCall();
    breaker.onFailure();

    // All prior failures are now outside the window — still CLOSED
    expect(breaker.state).toBe('CLOSED');
  });

  it('rejects calls immediately while OPEN', () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    expect(breaker.canCall()).toBe(false);
    expect(breaker.canCall()).toBe(false);
  });
});

describe('CircuitBreaker — OPEN → HALF_OPEN transition', () => {
  function openBreaker() {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }
    expect(breaker.state).toBe('OPEN');
    return { breaker, clock };
  }

  it('stays OPEN before halfOpenAfterMs elapses', () => {
    const { breaker, clock } = openBreaker();
    clock.advance(CONFIG.halfOpenAfterMs - 1);
    expect(breaker.canCall()).toBe(false);
    expect(breaker.state).toBe('OPEN');
  });

  it('transitions to HALF_OPEN at exactly halfOpenAfterMs', () => {
    const { breaker, clock } = openBreaker();
    clock.advance(CONFIG.halfOpenAfterMs);
    // Reading state triggers lazy transition
    expect(breaker.state).toBe('HALF_OPEN');
  });

  it('admits exactly one probe while HALF_OPEN', () => {
    const { breaker, clock } = openBreaker();
    clock.advance(CONFIG.halfOpenAfterMs);

    const first = breaker.canCall();
    const second = breaker.canCall();
    const third = breaker.canCall();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
  });
});

describe('CircuitBreaker — HALF_OPEN → CLOSED on successful probe', () => {
  it('closes after a successful probe', () => {
    const { breaker, clock } = makeBreaker();

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    clock.advance(CONFIG.halfOpenAfterMs);
    expect(breaker.canCall()).toBe(true);
    breaker.onSuccess();

    expect(breaker.state).toBe('CLOSED');
    // Should allow calls again
    expect(breaker.canCall()).toBe(true);
    expect(breaker.canCall()).toBe(true);
  });
});

describe('CircuitBreaker — HALF_OPEN → OPEN on failed probe', () => {
  it('reopens after a failed probe', () => {
    const { breaker, clock } = makeBreaker();

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    clock.advance(CONFIG.halfOpenAfterMs);
    expect(breaker.canCall()).toBe(true);
    breaker.onFailure();

    expect(breaker.state).toBe('OPEN');
    expect(breaker.canCall()).toBe(false);
  });

  it('allows a new probe after another halfOpenAfterMs following reopen', () => {
    const { breaker, clock } = makeBreaker();

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    clock.advance(CONFIG.halfOpenAfterMs);
    breaker.canCall();
    breaker.onFailure(); // Reopen

    clock.advance(CONFIG.halfOpenAfterMs);
    expect(breaker.canCall()).toBe(true); // New probe admitted
  });
});

describe('CircuitBreaker — rolling window edge cases', () => {
  it('counts only failures within the current window', () => {
    const { breaker, clock } = makeBreaker();

    // 3 failures at t=0
    for (let i = 0; i < 3; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // Advance so those 3 are outside the window
    clock.advance(CONFIG.rollingWindowMs + 1);

    // 4 more failures — window now only sees these 4
    for (let i = 0; i < 4; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // 3 + 4 = 7 total, but only 4 in current window — still CLOSED
    expect(breaker.state).toBe('CLOSED');

    // One more puts it at 5 within the window
    breaker.canCall();
    breaker.onFailure();
    expect(breaker.state).toBe('OPEN');
  });
});

describe('CircuitBreaker — metric emission', () => {
  it('emits a transition record on CLOSED → OPEN', () => {
    const spy = new SpyBreakerMetrics();
    const { breaker } = makeBreaker(spy);

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    expect(spy.transitions).toHaveLength(1);
    expect(spy.transitions[0]).toMatchObject({
      supplier: SUPPLIER,
      from: 'CLOSED',
      to: 'OPEN',
    });
  });

  it('emits transition records for OPEN → HALF_OPEN → CLOSED', () => {
    const spy = new SpyBreakerMetrics();
    const { breaker, clock } = makeBreaker(spy);

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    clock.advance(CONFIG.halfOpenAfterMs);
    breaker.canCall(); // triggers lazy OPEN → HALF_OPEN
    breaker.onSuccess();

    const tos = spy.transitions.map(t => t.to);
    expect(tos).toContain('HALF_OPEN');
    expect(tos).toContain('CLOSED');
  });

  it('emits warn log on CLOSED → OPEN', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const { breaker } = makeBreaker(undefined, logger);

    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breaker.canCall();
      breaker.onFailure();
    }

    // CLOSED → OPEN is logged at error level
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ supplier: SUPPLIER, newState: 'OPEN' }),
      expect.stringContaining('Circuit breaker transition'),
    );
  });
});

describe('CircuitBreaker — per-supplier isolation', () => {
  it('two breakers do not share state', () => {
    const clockA = new FakeClock(0);
    const breakerA = new CircuitBreaker('supplier-a', CONFIG, clockA);

    const clockB = new FakeClock(0);
    const breakerB = new CircuitBreaker('supplier-b', CONFIG, clockB);

    // Trip breaker A
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      breakerA.canCall();
      breakerA.onFailure();
    }

    expect(breakerA.state).toBe('OPEN');
    expect(breakerB.state).toBe('CLOSED');
    expect(breakerB.canCall()).toBe(true);
  });
});

describe('CircuitBreaker — success in CLOSED does not change state', () => {
  it('onSuccess in CLOSED is a no-op', () => {
    const { breaker } = makeBreaker();
    breaker.onSuccess();
    expect(breaker.state).toBe('CLOSED');
  });
});
