import { buildKey, buildKeyHash, buildLockKey } from './keyBuilder.js';
import type {
  BackgroundRefreshFn,
  CacheClock,
  CacheGetResult,
  CacheLogger,
  CacheMetrics,
  CachedSearchPayload,
  OfferIndexEntry,
  SearchCacheConfig,
  SearchCacheRedisClient,
  SearchCategory,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';
import { CacheHealthState, type CacheHealthConfig, DEFAULT_HEALTH_CONFIG } from './CacheHealthState.js';

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function isValidOfferIndexEntry(value: unknown): value is OfferIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['offer'] === 'object' && obj['offer'] !== null &&
    typeof obj['generatedAt'] === 'number' &&
    typeof obj['freshUntil'] === 'number' &&
    typeof obj['category'] === 'string'
  );
}

function isValidPayload(value: unknown): value is CachedSearchPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['schemaVersion'] === 'number' &&
    typeof obj['generatedAt'] === 'number' &&
    Array.isArray(obj['offers']) &&
    Array.isArray(obj['supplierOutcomes'])
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface SearchCacheRepositoryOptions {
  redis: SearchCacheRedisClient;
  clock: CacheClock;
  config: SearchCacheConfig;
  logger?: CacheLogger;
  metrics?: CacheMetrics;
  /** Health-state configuration. Defaults to DEFAULT_HEALTH_CONFIG. */
  healthConfig?: CacheHealthConfig;
}

/**
 * Redis-backed search result cache with two-tier freshness and single-flight
 * background refresh.
 *
 * Key format: `search:{category}:{sha256(canonicalJson(params))}`
 * Lock format: `search:lock:{category}:{same sha256}`
 *
 * Two-tier model:
 *  - Within freshnessWindow → stale: false (fresh hit, serve immediately)
 *  - Past freshnessWindow but within TTL → stale: true (serve stale, trigger
 *    one background refresh via SET NX PX lock)
 *  - Past TTL → Redis returns null (cache miss)
 *
 * All Redis errors are treated as misses — they never propagate as request
 * failures.  All write errors are logged and ignored.
 */
export class SearchCacheRepository {
  private readonly redis: SearchCacheRedisClient;
  private readonly clock: CacheClock;
  private readonly config: SearchCacheConfig;
  private readonly logger?: CacheLogger;
  private readonly metrics?: CacheMetrics;
  private readonly healthState: CacheHealthState;

  constructor(options: SearchCacheRepositoryOptions) {
    this.redis = options.redis;
    this.clock = options.clock;
    this.config = options.config;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.healthState = new CacheHealthState(
      options.healthConfig ?? DEFAULT_HEALTH_CONFIG,
      options.clock,
    );
  }

  /** Returns true when the cache is considered healthy and available. */
  isAvailable(): boolean {
    return this.healthState.isAvailable();
  }

  /** Exposes the underlying health state for domain-service timeout selection. */
  getHealthState(): CacheHealthState {
    return this.healthState;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Raw cache lookup.  Returns null on a miss, a corrupt entry, or a Redis
   * error.  Does not emit hit/miss metrics — use getWithRefresh for metered
   * lookups.
   */
  async get(
    category: SearchCategory,
    params: Record<string, unknown>,
  ): Promise<CacheGetResult | null> {
    return this._rawGet(category, params);
  }

  /**
   * Store a search result.  TTL is sourced from config per category.
   * Redis write errors are logged and silently ignored so a supplier result
   * is always returned to the caller.
   */
  async set(
    category: SearchCategory,
    params: Record<string, unknown>,
    payload: CachedSearchPayload,
  ): Promise<void> {
    const hash = buildKeyHash(params);
    const key = buildKey(category, hash);
    const ttlSeconds = this.config.ttlSeconds[category];

    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      this.logger?.error({ category, key }, 'Failed to serialise payload — skipping cache write');
      return;
    }

    try {
      await this.redis.setex(key, ttlSeconds, json);
      this.healthState.recordSuccess();
    } catch {
      this.healthState.recordFailure();
      this.metrics?.recordUnavailable(category);
      this.logger?.warn({ category, key }, 'Redis write error — skipping cache write');
    }

    // Write per-offer secondary index entries (offer:{id} → OfferIndexEntry).
    // Errors are logged and silently ignored so a supplier result is always returned.
    const freshnessWindowMs = this.config.freshnessWindowSeconds[category] * 1000;
    for (const offer of payload.offers) {
      const offerId = offer['id'];
      if (typeof offerId === 'string' && offerId.length > 0) {
        const entry: OfferIndexEntry = {
          offer,
          generatedAt: payload.generatedAt,
          freshUntil: payload.generatedAt + freshnessWindowMs,
          category,
        };
        try {
          await this.redis.setex(`offer:${offerId}`, ttlSeconds, JSON.stringify(entry));
        } catch {
          this.logger?.warn({ category, offerId }, 'Redis write error — skipping offer index write');
        }
      }
    }
  }

  /**
   * Look up a single offer by its deterministic ID from the secondary index.
   *
   * Returns null on a miss, a corrupt entry, or a Redis error — callers must
   * treat null as NOT_FOUND and never attempt to re-query suppliers.
   */
  async getOfferById(id: string): Promise<OfferIndexEntry | null> {
    const key = `offer:${id}`;
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch {
      this.logger?.warn({ key }, 'Redis read error for offer index — treating as miss');
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidOfferIndexEntry(parsed)) return parsed;
      this.logger?.warn({ key }, 'Corrupt offer index entry — treating as miss');
      return null;
    } catch {
      this.logger?.warn({ key }, 'Failed to parse offer index entry JSON — treating as miss');
      return null;
    }
  }

  /**
   * Metered lookup with automatic background refresh for stale entries.
   *
   * Returns:
   *  - null          → cache miss; caller must do a full supplier search
   *  - stale: false  → fresh hit; serve offers directly
   *  - stale: true   → stale hit; offers served immediately AND one background
   *                    refresh triggered (single-flight via Redis NX lock)
   *
   * The background refresh runs detached — this method returns without waiting
   * for it to complete.
   */
  async getWithRefresh(
    category: SearchCategory,
    params: Record<string, unknown>,
    refreshFn: BackgroundRefreshFn,
    correlationId: string,
  ): Promise<CacheGetResult | null> {
    const result = await this._rawGet(category, params);

    if (result === null) {
      this.metrics?.recordMiss(category);
      return null;
    }

    if (!result.stale) {
      this.metrics?.recordHit(category);
      return result;
    }

    // Stale hit: serve immediately, try to acquire single-flight lock
    this.metrics?.recordStaleServe(category);

    const hash = buildKeyHash(params);
    const lockKey = buildLockKey(category, hash);
    let lockAcquired: boolean;
    try {
      lockAcquired = await this.redis.setNxPx(lockKey, '1', this.config.lockTtlMs);
    } catch {
      // Redis error acquiring lock — just serve stale without refresh
      lockAcquired = false;
      this.logger?.warn({ category, correlationId, lockKey }, 'Redis error acquiring refresh lock — serving stale only');
    }

    if (lockAcquired) {
      const refreshCorrelationId = `${correlationId}:bg-refresh`;
      // Detached — intentionally not awaited
      void this._runBackgroundRefresh(
        category,
        params,
        lockKey,
        refreshFn,
        refreshCorrelationId,
      );
    } else {
      this.metrics?.recordSingleflightSuppressed(category);
      this.logger?.warn(
        { category, correlationId, lockKey },
        'Single-flight lock not acquired — serving stale, refresh suppressed',
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _rawGet(
    category: SearchCategory,
    params: Record<string, unknown>,
  ): Promise<CacheGetResult | null> {
    const hash = buildKeyHash(params);
    const key = buildKey(category, hash);

    // If UNAVAILABLE and not yet time to probe, skip Redis entirely.
    if (!this.healthState.isAvailable() && !this.healthState.shouldProbe()) {
      this.metrics?.recordUnavailable(category);
      this.logger?.warn({ category, key }, 'Cache unavailable — skipping Redis read (no-op)');
      return null;
    }

    if (this.healthState.shouldProbe()) {
      this.healthState.markProbeAttempt();
    }

    let raw: string | null;
    try {
      raw = await this.redis.get(key);
      this.healthState.recordSuccess();
    } catch {
      this.healthState.recordFailure();
      this.metrics?.recordUnavailable(category);
      this.logger?.warn({ category, key }, 'Redis read error — treating as cache miss');
      return null;
    }

    if (raw === null) return null;

    let payload: CachedSearchPayload;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidPayload(parsed)) {
        this.logger?.warn({ category, key }, 'Corrupt or incomplete payload — treating as miss and deleting');
        void this.redis.del(key).catch(() => { /* ignore del errors */ });
        return null;
      }
      payload = parsed;
    } catch {
      this.logger?.warn({ category, key }, 'Failed to parse cached payload JSON — treating as miss and deleting');
      void this.redis.del(key).catch(() => { /* ignore del errors */ });
      return null;
    }

    if (payload.schemaVersion !== SCHEMA_VERSION) {
      this.logger?.warn(
        { category, key, payloadVersion: payload.schemaVersion, currentVersion: SCHEMA_VERSION },
        'Schema version mismatch — treating as miss',
      );
      return null;
    }

    const ageMs = this.clock.now() - payload.generatedAt;
    const freshnessWindowMs = this.config.freshnessWindowSeconds[category] * 1000;
    const stale = ageMs > freshnessWindowMs;

    return {
      payload,
      stale,
      generatedAt: new Date(payload.generatedAt),
      key,
    };
  }

  private async _runBackgroundRefresh(
    category: SearchCategory,
    params: Record<string, unknown>,
    lockKey: string,
    refreshFn: BackgroundRefreshFn,
    correlationId: string,
  ): Promise<void> {
    try {
      const newPayload = await refreshFn(category, params, correlationId);
      await this.set(category, params, newPayload);
      this.logger?.info(
        { category, correlationId },
        'Background cache refresh completed',
      );
    } catch {
      // Never log the raw error — it may contain supplier internals (BR-13)
      this.logger?.error(
        { category, correlationId },
        'Background cache refresh failed — stale entry retained until TTL expiry',
      );
    } finally {
      // Release lock; if this fails the lock self-expires at lockTtlMs
      await this.redis.del(lockKey).catch(() => { /* swallow */ });
    }
  }
}
