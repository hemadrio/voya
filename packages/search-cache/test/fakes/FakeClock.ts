import type { CacheClock } from '../../src/types.js';

/**
 * Deterministic clock for unit tests.
 * Advance time explicitly via advance() — no real timers involved.
 */
export class FakeClock implements CacheClock {
  private _time: number;

  constructor(initialMs = 0) {
    this._time = initialMs;
  }

  now(): number {
    return this._time;
  }

  advance(ms: number): void {
    this._time += ms;
  }

  set(ms: number): void {
    this._time = ms;
  }
}
