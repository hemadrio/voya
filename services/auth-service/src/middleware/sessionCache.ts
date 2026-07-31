/**
 * SessionValidityCache — short-lived in-process TTL cache for session
 * validity lookups.
 *
 * Motivation: bearer-auth middleware must confirm the session is still active
 * on every request, but hitting the database every request is expensive at
 * scale.  A short TTL (default 30 s) means revocation takes effect within the
 * window on any given node; the revocation path calls `invalidate()` to make
 * the effect immediate on the node that processed the logout.
 *
 * Multi-instance note: only the node that processed the revocation invalidates
 * its cache entry immediately.  Other nodes will see the revocation once their
 * TTL entry expires (≤ cacheTtlMs).  This is documented as an eventual-
 * consistency window; keep cacheTtlMs ≤ 30 s to bound the window.
 *
 * Implementation uses a plain Map; no external dependency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedSessionEntry {
  userId: string;
  /** true when the session is valid (not revoked and not idle-expired). */
  valid: boolean;
  /** Roles resolved for this session (from token or DB). */
  roles: string[];
  /** Permissions resolved from the user's roles. */
  permissions: string[];
  /** Monotonic expiry timestamp (from performance.now()). */
  expiresAtMs: number;
}

export interface SessionCacheOptions {
  /**
   * Cache TTL in milliseconds.
   * Default: 30_000 (30 seconds).
   * Must be ≤ 30_000 to ensure revocation takes effect promptly.
   */
  ttlMs?: number;
  /** Injected clock — defaults to performance.now. Override in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface ISessionCache {
  get(sessionId: string): CachedSessionEntry | undefined;
  set(sessionId: string, entry: Omit<CachedSessionEntry, "expiresAtMs">): void;
  /**
   * Remove a specific session from the cache.
   * Call from revocation paths (logout, revokeFamily) to make revocation
   * immediate on the current node.
   */
  invalidate(sessionId: string): void;
  /** Purge all expired entries (housekeeping — call periodically). */
  purgeExpired(): void;
  /** Number of entries currently in the cache (for metrics/tests). */
  size(): number;
}

export function createSessionCache(options: SessionCacheOptions = {}): ISessionCache {
  const ttlMs = options.ttlMs ?? 30_000;
  const getNow = options.now ?? (() => performance.now());

  const store = new Map<string, CachedSessionEntry>();

  function get(sessionId: string): CachedSessionEntry | undefined {
    const entry = store.get(sessionId);
    if (!entry) return undefined;
    if (getNow() >= entry.expiresAtMs) {
      store.delete(sessionId);
      return undefined;
    }
    return entry;
  }

  function set(sessionId: string, entry: Omit<CachedSessionEntry, "expiresAtMs">): void {
    store.set(sessionId, { ...entry, expiresAtMs: getNow() + ttlMs });
  }

  function invalidate(sessionId: string): void {
    store.delete(sessionId);
  }

  function purgeExpired(): void {
    const now = getNow();
    for (const [id, entry] of store) {
      if (now >= entry.expiresAtMs) store.delete(id);
    }
  }

  function size(): number {
    return store.size;
  }

  return { get, set, invalidate, purgeExpired, size };
}
