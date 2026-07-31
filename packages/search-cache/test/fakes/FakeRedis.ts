import type { CacheClock, SearchCacheRedisClient } from '../../src/types.js';

interface StoreEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * In-memory Redis double for unit tests.
 *
 * Supports TTL via an injected clock so freshness and expiry tests are
 * fully deterministic without real time or a live Redis instance.
 */
export class FakeRedis implements SearchCacheRedisClient {
  private readonly _store = new Map<string, StoreEntry>();
  private readonly _clock: CacheClock;

  /** Counts how many times setNxPx was called — useful for concurrency assertions. */
  setNxPxCallCount = 0;

  constructor(clock: CacheClock) {
    this._clock = clock;
  }

  private _isAlive(entry: StoreEntry): boolean {
    return entry.expiresAt === null || this._clock.now() < entry.expiresAt;
  }

  async get(key: string): Promise<string | null> {
    const entry = this._store.get(key);
    if (entry === undefined || !this._isAlive(entry)) return null;
    return entry.value;
  }

  async setex(key: string, seconds: number, value: string): Promise<'OK'> {
    this._store.set(key, {
      value,
      expiresAt: this._clock.now() + seconds * 1000,
    });
    return 'OK';
  }

  async setNxPx(key: string, value: string, milliseconds: number): Promise<boolean> {
    this.setNxPxCallCount++;
    const existing = this._store.get(key);
    if (existing !== undefined && this._isAlive(existing)) {
      return false; // Lock already held
    }
    this._store.set(key, {
      value,
      expiresAt: this._clock.now() + milliseconds,
    });
    return true;
  }

  async del(key: string): Promise<number> {
    return this._store.delete(key) ? 1 : 0;
  }

  async pttl(key: string): Promise<number> {
    const entry = this._store.get(key);
    if (entry === undefined) return -2; // Key absent
    if (entry.expiresAt === null) return -1; // No TTL
    const remaining = entry.expiresAt - this._clock.now();
    return remaining > 0 ? remaining : -2;
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  has(key: string): boolean {
    const entry = this._store.get(key);
    return entry !== undefined && this._isAlive(entry);
  }

  size(): number {
    return [...this._store.values()].filter(e => this._isAlive(e)).length;
  }

  clear(): void {
    this._store.clear();
    this.setNxPxCallCount = 0;
  }
}
