/**
 * DedupCachePort — Redis SET NX fast-path deduplication for Stripe webhooks.
 *
 * This is the hot-path layer of the doubly-guarded idempotency design:
 *   Layer 1 (this):   Redis SET NX with a 72-hour TTL — avoids the DB write
 *                     cost on repeated delivery.
 *   Layer 2 (auth):   processed_events UNIQUE (provider, event_id) constraint
 *                     — the durable authority that survives Redis eviction,
 *                     restart, or outage.
 *
 * Failure contract (BR-03):
 *   A Redis UNAVAILABILITY must NEVER skip processing.
 *   tryAcquire() throws when the cache is unreachable; callers MUST catch
 *   and fall through to the durable DB layer rather than short-circuiting.
 *
 * Key format: `stripe:event:{eventId}`
 * TTL: 259200 seconds (72 hours — matches Stripe's maximum retry window)
 *
 * Injectable: tests supply in-memory fakes without a real Redis instance.
 */

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * Deduplication cache port.
 *
 * Callers must tolerate two outcomes:
 *   - tryAcquire returns false → duplicate; skip processing (200 no-op)
 *   - tryAcquire throws       → cache unavailable; fall through to DB layer
 */
export interface DedupCachePort {
  /**
   * Attempt to atomically set the key with SET NX EX semantics.
   *
   * @returns true  — key was set (this is the first delivery; proceed)
   * @returns false — key already exists (duplicate delivery; return 200 no-op)
   * @throws        — cache is unavailable; caller must fall through to DB
   */
  tryAcquire(key: string, ttlSeconds: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Stripe-specific key helper
// ---------------------------------------------------------------------------

/** Canonical cache key for a Stripe event id. */
export const stripeEventCacheKey = (eventId: string): string =>
  `stripe:event:${eventId}`;

/** Standard Stripe retry window TTL — 72 hours in seconds. */
export const STRIPE_DEDUP_TTL_SECONDS = 259200;

// ---------------------------------------------------------------------------
// InMemoryDedupCache — deterministic in-memory implementation for tests
// ---------------------------------------------------------------------------

/**
 * In-memory dedup cache backed by a plain Map.
 *
 * Uses real clock-based TTL so tests that call tryAcquire twice without
 * clock manipulation get a deterministic DUPLICATE result.
 *
 * Constructor accepts an optional `nowMs` clock function for time travel.
 */
export class InMemoryDedupCache implements DedupCachePort {
  private readonly store = new Map<string, number>(); // key → expiresAtMs
  private readonly nowMs: () => number;

  constructor(clock?: () => number) {
    this.nowMs = clock ?? (() => Date.now());
  }

  async tryAcquire(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.nowMs();
    const expiry = this.store.get(key);
    if (expiry !== undefined && expiry > now) {
      return false; // key exists and is not expired
    }
    this.store.set(key, now + ttlSeconds * 1000);
    return true;
  }

  /** Evict a key (simulates Redis eviction for testing the DB fallthrough). */
  evict(key: string): void {
    this.store.delete(key);
  }

  /** Flush all keys (simulates Redis restart). */
  flushAll(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// UnavailableDedupCache — always throws (for testing the Redis-down path)
// ---------------------------------------------------------------------------

/**
 * A dedup cache that always throws ECONNREFUSED.
 *
 * Inject this to verify the Redis-unavailable fallthrough path:
 * the processor must NOT skip processing — it must fall through to the
 * durable DB unique constraint.
 */
export class UnavailableDedupCache implements DedupCachePort {
  async tryAcquire(_key: string, _ttlSeconds: number): Promise<boolean> {
    throw new Error("Redis ECONNREFUSED: connection refused");
  }
}
