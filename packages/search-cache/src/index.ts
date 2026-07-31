export type {
  BackgroundRefreshFn,
  CacheClock,
  CacheGetResult,
  CacheLogger,
  CacheMetrics,
  CachedSearchPayload,
  CategoryValues,
  OfferIndexEntry,
  SearchCacheConfig,
  SearchCacheRedisClient,
  SearchCategory,
} from './types.js';

export {
  DEFAULT_CACHE_CONFIG,
  SCHEMA_VERSION,
  SystemCacheClock,
} from './types.js';

export { canonicalJson, buildKey, buildKeyHash, buildLockKey } from './keyBuilder.js';

export {
  SearchCacheRepository,
  type SearchCacheRepositoryOptions,
} from './SearchCacheRepository.js';

export {
  SpyCacheMetrics,
  createOtelCacheMetrics,
} from './metrics.js';

export {
  CacheHealthState,
  DEFAULT_HEALTH_CONFIG,
  type CacheHealthConfig,
  type CacheHealthStatus,
} from './CacheHealthState.js';
