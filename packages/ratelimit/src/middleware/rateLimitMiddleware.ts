/**
 * Express middleware factory for tiered rate limiting.
 *
 * Sets response headers:
 *   - Retry-After (integer seconds, required on 429)
 *   - RateLimit-Remaining (informational)
 *   - RateLimit-Reset (informational, unix epoch seconds)
 *
 * On rejection, responds with HTTP 429 and the standard error envelope.
 * Never discloses internal counter values of other actors.
 */

import type { RateLimiter } from '../slidingWindowLimiter.js';
import { buildKey, COST_CLASS, type CostClass, type ActorTier } from '../config/tiers.js';

export interface RateLimitRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  /**
   * Actor tier derived from verified JWT roles.
   * Undefined for unauthenticated (guest) requests.
   */
  actorTier?: ActorTier;
  /**
   * Authenticated actor ID (ULID).
   * Undefined for guest requests — falls back to client IP.
   */
  actorId?: string;
}

export interface RateLimitResponse {
  status(code: number): this;
  set(header: string, value: string): this;
  json(body: unknown): this;
}

export type RateLimitNext = (err?: unknown) => void;

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Scope label distinguishing gateway ('gw') from per-service floors (e.g. 'auth'). */
  scope: string;
  /**
   * Resolve the cost class from the request path/method.
   * Should return the CostClass for this request.
   */
  getCostClass(req: RateLimitRequest): CostClass;
  /**
   * Resolve the actor identifier for key derivation.
   * Defaults to actorId (authenticated) or x-forwarded-for / x-real-ip (guest).
   */
  getActorOrIp?(req: RateLimitRequest): string;
  /**
   * Resolve the actor tier.
   * Defaults to req.actorTier ?? 'guest'.
   */
  getTier?(req: RateLimitRequest): ActorTier;
  /** Metrics/alarm emitter for throttled requests. */
  onThrottled?(tier: ActorTier, costClass: CostClass): void;
}

function defaultGetActorOrIp(req: RateLimitRequest): string {
  if (req.actorId) return req.actorId;
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) return raw.split(',')[0]?.trim() ?? 'unknown';
  const xri = req.headers['x-real-ip'];
  return (Array.isArray(xri) ? xri[0] : xri) ?? 'unknown';
}

function makeErrorBody(code: string, message: string, reference: string) {
  return { error: { code, message }, reference };
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const {
    limiter,
    scope,
    getCostClass,
    getActorOrIp = defaultGetActorOrIp,
    getTier = (req) => req.actorTier ?? 'guest',
    onThrottled,
  } = options;

  return async function rateLimitMiddleware(
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: RateLimitNext,
  ): Promise<void> {
    const tier = getTier(req);
    const costClass = getCostClass(req);
    const actorOrIp = getActorOrIp(req);
    const key = buildKey(scope, tier, actorOrIp, costClass);
    const cost = COST_CLASS[costClass];
    const reference = req.correlationId ?? 'unknown';

    const result = await limiter.consume(key, cost);

    const resetEpoch = Math.floor(Date.now() / 1000) + result.resetAfterSeconds;
    res.set('RateLimit-Remaining', String(result.remaining));
    res.set('RateLimit-Reset', String(resetEpoch));

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAfterSeconds);
      res.set('Retry-After', String(retryAfter));
      onThrottled?.(tier, costClass);
      res
        .status(429)
        .json(
          makeErrorBody(
            'RATE_LIMITED',
            `Too many requests. Please try again in ${retryAfter} seconds.`,
            reference,
          ),
        );
      return;
    }

    next();
  };
}
