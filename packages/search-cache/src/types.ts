// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export type SearchCategory = 'flight' | 'hotel' | 'car';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CategoryValues {
  flight: number;
  hotel: number;
  car: number;
}

export interface SearchCacheConfig {
  /** Redis TTL per category in seconds. */
  ttlSeconds: CategoryValues;
  /**
   * Freshness window per category in seconds.
   * Entries older than this (but within TTL) are served as stale and trigger
   * a background refresh.
   */
  freshnessWindowSeconds: CategoryValues;
  /**
   * Lock TTL for the single-flight refresh lock in milliseconds.
   * Should be slightly above the supplier fan-out budget so the lock
   * self-expires if the process dies during a refresh.
   */
  lockTtlMs: number;
}

export const DEFAULT_CACHE_CONFIG: SearchCacheConfig = {
  ttlSeconds: { flight: 300, hotel: 900, car: 1800 },
  // Freshness windows are one-fifth of TTL — keep pricing hot but avoid
  // overwhelming suppliers on every request.
  freshnessWindowSeconds: { flight: 60, hotel: 180, car: 360 },
  lockTtlMs: 3_500, // 300 ms above the 3200 ms supplier fan-out + serialisation budget
};

// ---------------------------------------------------------------------------
// Cached payload
// ---------------------------------------------------------------------------

/** Increment this whenever the payload shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

/**
 * Payload serialised to Redis as JSON.
 *
 * schemaVersion mismatch → treat as miss (never deserialise with wrong schema).
 * generatedAt is a Unix millisecond timestamp so freshness decisions are
 * independent of Redis key TTL (which may have drifted on failover).
 */
export interface CachedSearchPayload {
  readonly schemaVersion: number;
  /** Unix ms timestamp — set by the caller at the time of the supplier search. */
  readonly generatedAt: number;
  readonly offers: ReadonlyArray<Record<string, unknown>>;
  readonly supplierOutcomes: ReadonlyArray<{ readonly supplier: string; readonly outcome: string }>;
}

// ---------------------------------------------------------------------------
// Offer secondary index
// ---------------------------------------------------------------------------

/**
 * Secondary index entry written for each offer at search-cache-set time.
 *
 * Key format: `offer:{offerId}` — expires at the same TTL as the parent search entry.
 * Enables GET /v1/offers/{id} to resolve without re-querying suppliers.
 */
export interface OfferIndexEntry {
  /** Full normalised offer object as stored in CachedSearchPayload.offers. */
  readonly offer: Record<string, unknown>;
  /** Unix ms — copied from CachedSearchPayload.generatedAt. */
  readonly generatedAt: number;
  /** Unix ms — generatedAt + freshnessWindowSeconds * 1000. */
  readonly freshUntil: number;
  readonly category: SearchCategory;
}

// ---------------------------------------------------------------------------
// Cache operation result
// ---------------------------------------------------------------------------

export interface CacheGetResult {
  readonly payload: CachedSearchPayload;
  /** True when the entry is past its freshnessWindow but within TTL. */
  readonly stale: boolean;
  /** Derived from payload.generatedAt for consumer convenience. */
  readonly generatedAt: Date;
  /** Full Redis key — included for logging and tracing. */
  readonly key: string;
}

// ---------------------------------------------------------------------------
// Redis client interface (duck-typed — ioredis satisfies this)
// ---------------------------------------------------------------------------

export interface SearchCacheRedisClient {
  get(key: string): Promise<string | null>;
  /** SET key value EX seconds */
  setex(key: string, seconds: number, value: string): Promise<'OK'>;
  /**
   * SET key value NX PX milliseconds
   * Returns true if the key was set (lock acquired), false otherwise.
   */
  setNxPx(key: string, value: string, milliseconds: number): Promise<boolean>;
  del(key: string): Promise<number>;
  /** Returns remaining TTL in milliseconds, or -1 (no TTL) / -2 (expired / absent). */
  pttl(key: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Background refresh function type
// ---------------------------------------------------------------------------

/**
 * Called by SearchCacheRepository when a stale entry triggers a background
 * refresh. The correlationId is derived from the originating request's
 * correlation ID so traces are linked.
 *
 * Must return a fully-formed payload to store, or throw on failure.
 */
export type BackgroundRefreshFn = (
  category: SearchCategory,
  params: Record<string, unknown>,
  correlationId: string,
) => Promise<CachedSearchPayload>;

// ---------------------------------------------------------------------------
// Clock abstraction (injectable for test determinism)
// ---------------------------------------------------------------------------

export interface CacheClock {
  now(): number;
}

export class SystemCacheClock implements CacheClock {
  now(): number {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// Logger interface (Pino subset)
// ---------------------------------------------------------------------------

export interface CacheLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Metrics interface (injectable for test assertions)
// ---------------------------------------------------------------------------

export interface CacheMetrics {
  recordHit(category: string): void;
  recordMiss(category: string): void;
  recordStaleServe(category: string): void;
  recordSingleflightSuppressed(category: string): void;
}
