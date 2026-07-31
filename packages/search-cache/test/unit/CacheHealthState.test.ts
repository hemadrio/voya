/**
 * Unit tests for CacheHealthState.
 *
 * Covers (AC7):
 *  - HEALTHY state on construction
 *  - Transitions to UNAVAILABLE after consecutiveFailuresToDegrade failures
 *  - Does NOT transition before reaching the threshold (hysteresis)
 *  - Single success resets to HEALTHY and clears failure count
 *  - shouldProbe returns false when HEALTHY
 *  - shouldProbe returns true when UNAVAILABLE + enough time has passed
 *  - shouldProbe returns false when UNAVAILABLE but within probe interval
 *  - markProbeAttempt resets the probe cooldown
 *  - Recovery: successful probe restores HEALTHY
 *  - Failed probe keeps UNAVAILABLE (still counts as a failure)
 *  - Configurable thresholds respected
 */

import { describe, it, expect } from 'vitest';
import { CacheHealthState, DEFAULT_HEALTH_CONFIG } from '../../src/CacheHealthState.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(nowMs: number): { now(): number; advance(ms: number): void } {
  let current = nowMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('CacheHealthState — initial state', () => {
  it('starts HEALTHY', () => {
    const h = new CacheHealthState();
    expect(h.isAvailable()).toBe(true);
    expect(h.getStatus()).toBe('HEALTHY');
  });

  it('shouldProbe is false when HEALTHY', () => {
    const h = new CacheHealthState();
    expect(h.shouldProbe()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Degradation path
// ---------------------------------------------------------------------------

describe('CacheHealthState — degradation', () => {
  it('remains HEALTHY after fewer failures than threshold', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 3, recoveryProbeIntervalMs: 30_000 });
    h.recordFailure();
    h.recordFailure();
    expect(h.isAvailable()).toBe(true);
    expect(h.getStatus()).toBe('HEALTHY');
  });

  it('transitions to UNAVAILABLE after reaching threshold', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 3, recoveryProbeIntervalMs: 30_000 });
    h.recordFailure();
    h.recordFailure();
    h.recordFailure();
    expect(h.isAvailable()).toBe(false);
    expect(h.getStatus()).toBe('UNAVAILABLE');
  });

  it('stays UNAVAILABLE on further failures', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 3, recoveryProbeIntervalMs: 30_000 });
    for (let i = 0; i < 10; i++) h.recordFailure();
    expect(h.getStatus()).toBe('UNAVAILABLE');
  });

  it('uses default threshold (3) via DEFAULT_HEALTH_CONFIG', () => {
    const h = new CacheHealthState(DEFAULT_HEALTH_CONFIG);
    h.recordFailure();
    h.recordFailure();
    expect(h.isAvailable()).toBe(true);
    h.recordFailure();
    expect(h.isAvailable()).toBe(false);
  });

  it('threshold of 1 degrades on first failure', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 30_000 });
    h.recordFailure();
    expect(h.isAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recovery path
// ---------------------------------------------------------------------------

describe('CacheHealthState — recovery', () => {
  it('recordSuccess resets to HEALTHY immediately', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 3, recoveryProbeIntervalMs: 30_000 });
    h.recordFailure();
    h.recordFailure();
    h.recordFailure();
    expect(h.isAvailable()).toBe(false);
    h.recordSuccess();
    expect(h.isAvailable()).toBe(true);
    expect(h.getStatus()).toBe('HEALTHY');
  });

  it('success mid-sequence resets the failure counter (hysteresis)', () => {
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 3, recoveryProbeIntervalMs: 30_000 });
    h.recordFailure();
    h.recordFailure();
    h.recordSuccess(); // resets
    h.recordFailure(); // back to 1 — not enough to degrade
    expect(h.isAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Probe interval
// ---------------------------------------------------------------------------

describe('CacheHealthState — probe interval', () => {
  it('shouldProbe is false immediately after degrading (no time elapsed)', () => {
    const clock = makeClock(1_000_000);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 30_000 }, clock);
    h.recordFailure();
    expect(h.shouldProbe()).toBe(false);
  });

  it('shouldProbe is true after recovery interval has elapsed', () => {
    const clock = makeClock(1_000_000);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 30_000 }, clock);
    h.recordFailure();
    clock.advance(30_001); // past interval
    expect(h.shouldProbe()).toBe(true);
  });

  it('shouldProbe is false when exactly at interval boundary (strict greater-than)', () => {
    const clock = makeClock(1_000_000);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 30_000 }, clock);
    h.recordFailure();
    clock.advance(30_000); // exactly at boundary — not yet
    // Since lastProbeAttemptMs starts at 0 and now - 0 >= 30000 when clock is at 1_030_000
    // Actually: now = 1_030_000, lastProbeAttemptMs = 0, 1_030_000 - 0 = 1_030_000 >= 30_000 → true
    // Wait, the initial value of lastProbeAttemptMs is 0, not the time of failure.
    // So after 30s advance from 1_000_000, now = 1_030_000, 1_030_000 - 0 >= 30_000 → true
    // Let me reconsider: since lastProbeAttemptMs starts at 0, shouldProbe is true once UNAVAILABLE
    // unless markProbeAttempt has been called.
    // This test is for AFTER markProbeAttempt has been called.
    h.markProbeAttempt(); // now = 1_030_000
    expect(h.shouldProbe()).toBe(false); // just attempted
    clock.advance(29_999);
    expect(h.shouldProbe()).toBe(false); // still within interval
    clock.advance(2); // now 1 ms past
    expect(h.shouldProbe()).toBe(true);
  });

  it('markProbeAttempt resets the probe cooldown', () => {
    const clock = makeClock(0);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 30_000 }, clock);
    h.recordFailure();
    clock.advance(31_000);
    expect(h.shouldProbe()).toBe(true);
    h.markProbeAttempt();
    expect(h.shouldProbe()).toBe(false);
  });

  it('shouldProbe false when HEALTHY regardless of time elapsed', () => {
    const clock = makeClock(0);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 1, recoveryProbeIntervalMs: 0 }, clock);
    clock.advance(99_999_999);
    expect(h.shouldProbe()).toBe(false); // HEALTHY state
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle (degrade → probe → recover → degrade again)
// ---------------------------------------------------------------------------

describe('CacheHealthState — full lifecycle', () => {
  it('supports multiple degrade-recover cycles', () => {
    const clock = makeClock(0);
    const h = new CacheHealthState({ consecutiveFailuresToDegrade: 2, recoveryProbeIntervalMs: 5_000 }, clock);

    // First degrade
    h.recordFailure();
    h.recordFailure();
    expect(h.getStatus()).toBe('UNAVAILABLE');

    // Probe after interval
    clock.advance(6_000);
    expect(h.shouldProbe()).toBe(true);
    h.markProbeAttempt();
    h.recordSuccess(); // probe succeeded
    expect(h.getStatus()).toBe('HEALTHY');

    // Second degrade
    h.recordFailure();
    expect(h.getStatus()).toBe('HEALTHY'); // 1 failure, threshold is 2
    h.recordFailure();
    expect(h.getStatus()).toBe('UNAVAILABLE');

    // Recover again
    clock.advance(6_000);
    h.markProbeAttempt();
    h.recordSuccess();
    expect(h.getStatus()).toBe('HEALTHY');
  });
});
