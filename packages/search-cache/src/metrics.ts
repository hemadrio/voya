import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import type { CacheMetrics } from './types.js';

// ---------------------------------------------------------------------------
// OTel counters — lazily initialised so the SDK can be registered before use
// ---------------------------------------------------------------------------

let _hitsCounter: Counter | null = null;
let _missesCounter: Counter | null = null;
let _staleServesCounter: Counter | null = null;
let _suppressedCounter: Counter | null = null;
let _unavailableCounter: Counter | null = null;

function meter() {
  return metrics.getMeter('@travel/search-cache');
}

function hitsCounter(): Counter {
  _hitsCounter ??= meter().createCounter('search_cache_hits_total', {
    description: 'Fresh cache hits by search category',
  });
  return _hitsCounter;
}

function missesCounter(): Counter {
  _missesCounter ??= meter().createCounter('search_cache_misses_total', {
    description: 'Cache misses (key absent or expired) by search category',
  });
  return _missesCounter;
}

function staleServesCounter(): Counter {
  _staleServesCounter ??= meter().createCounter('search_cache_stale_serves_total', {
    description: 'Stale-but-served cache hits by search category',
  });
  return _staleServesCounter;
}

function suppressedCounter(): Counter {
  _suppressedCounter ??= meter().createCounter(
    'search_cache_refresh_singleflight_suppressed_total',
    { description: 'Background refreshes suppressed by single-flight lock per category' },
  );
  return _suppressedCounter;
}

function unavailableCounter(): Counter {
  _unavailableCounter ??= meter().createCounter('search_cache_unavailable_total', {
    description: 'Cache operations that failed due to Redis unavailability (warn-logged and converted to no-op)',
  });
  return _unavailableCounter;
}

// ---------------------------------------------------------------------------
// OTel-backed implementation
// ---------------------------------------------------------------------------

export function createOtelCacheMetrics(): CacheMetrics {
  return {
    recordHit(category: string): void {
      hitsCounter().add(1, { category });
    },
    recordMiss(category: string): void {
      missesCounter().add(1, { category });
    },
    recordStaleServe(category: string): void {
      staleServesCounter().add(1, { category });
    },
    recordSingleflightSuppressed(category: string): void {
      suppressedCounter().add(1, { category });
    },
    recordUnavailable(category: string): void {
      unavailableCounter().add(1, { category });
    },
  };
}

// ---------------------------------------------------------------------------
// Spy implementation for unit tests
// ---------------------------------------------------------------------------

export class SpyCacheMetrics implements CacheMetrics {
  hits: Array<string> = [];
  misses: Array<string> = [];
  staleServes: Array<string> = [];
  singleflightSuppressed: Array<string> = [];
  unavailable: Array<string> = [];

  recordHit(category: string): void { this.hits.push(category); }
  recordMiss(category: string): void { this.misses.push(category); }
  recordStaleServe(category: string): void { this.staleServes.push(category); }
  recordSingleflightSuppressed(category: string): void { this.singleflightSuppressed.push(category); }
  recordUnavailable(category: string): void { this.unavailable.push(category); }

  reset(): void {
    this.hits = [];
    this.misses = [];
    this.staleServes = [];
    this.singleflightSuppressed = [];
    this.unavailable = [];
  }
}
