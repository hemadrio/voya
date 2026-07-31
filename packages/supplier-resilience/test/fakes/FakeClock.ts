import type { Clock } from '../../src/types.js';

interface PendingTimer {
  deadline: number;
  resolve: () => void;
}

/**
 * Deterministic clock for unit and integration tests.
 *
 * `schedule(ms)` registers a callback that resolves when `advance()` is called
 * with a cumulative delta that meets or exceeds the deadline.  No real timers
 * are used — tests control all timing via `advance()`.
 *
 * Important: `schedule()` is called SYNCHRONOUSLY inside the task functions
 * before they suspend on `await`, so all deadlines are registered before the
 * test calls `advance()`.
 */
export class FakeClock implements Clock {
  private _time: number;
  private readonly _pending: PendingTimer[] = [];

  constructor(initialMs = 0) {
    this._time = initialMs;
  }

  now(): number {
    return this._time;
  }

  schedule(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const deadline = this._time + ms;
    return new Promise<void>(resolve => {
      this._pending.push({ deadline, resolve });
    });
  }

  /**
   * Advances the clock by `deltaMs` milliseconds and fires all registered
   * callbacks whose deadline has been reached.
   */
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

  /** Number of pending (not yet fired) timers — useful for test assertions. */
  get pendingCount(): number {
    return this._pending.length;
  }
}
