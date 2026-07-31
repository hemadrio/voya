export type {
  ConsumeResult,
  RedisClient,
  RateLimitAlarm,
  RateLimiterOptions,
  RateLimiter,
} from './slidingWindowLimiter.js';
export { createRateLimiter } from './slidingWindowLimiter.js';

export type { ActorTier, CostClass } from './config/tiers.js';
export {
  WINDOW_MS,
  TIER_LIMITS,
  COST_CLASS,
  FLOOR_LIMIT,
  AUTH_LOCKOUT,
  tierFromRoles,
  buildKey,
} from './config/tiers.js';

export type {
  RateLimitMiddlewareOptions,
  RateLimitRequest,
  RateLimitResponse,
  RateLimitNext,
} from './middleware/rateLimitMiddleware.js';
export { createRateLimitMiddleware } from './middleware/rateLimitMiddleware.js';
