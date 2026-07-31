/**
 * Tiered gateway rate-limit middleware.
 *
 * Resolves the actor tier from the verified x-internal-actor context (set by
 * authenticate middleware), then delegates to the shared Redis sliding-window
 * limiter.  Guest requests (no actor context) are keyed on client IP.
 *
 * Must be mounted AFTER authenticate so that tier is always derivable.
 * One Redis round trip per request — satisfies the 20 ms budget constraint.
 */

import { verifyActorContext } from '@travel/auth';
import {
  createRateLimiter,
  createRateLimitMiddleware,
  tierFromRoles,
  TIER_LIMITS,
  WINDOW_MS,
  FLOOR_LIMIT,
  buildKey,
  COST_CLASS,
  type RedisClient,
  type RateLimitAlarm,
  type CostClass,
} from '@travel/ratelimit';

// Duck-typed Express-compatible interfaces (no express import so this package
// stays framework-agnostic and avoids circular augmentation issues).
interface RequestLike {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  socket?: { remoteAddress?: string } | null;
}

interface ResponseLike {
  status(code: number): this;
  set(header: string, value: string): this;
  json(body: unknown): this;
}

type NextFn = () => void;

// ---------------------------------------------------------------------------
// Cost class resolution by method + path prefix
// ---------------------------------------------------------------------------

/** Map request method + path to a cost class. */
function resolveCostClass(method: string, path: string): CostClass {
  const m = method.toUpperCase();
  if (m === 'POST') {
    if (
      path.startsWith('/v1/bookings') ||
      path.startsWith('/v1/payments') ||
      path.startsWith('/v1/chat')
    ) {
      return 'expensive';
    }
    // Other POST (register, login, forgot-password)
    return 'standard';
  }
  if (m === 'GET' || m === 'HEAD') {
    return 'cheap_read';
  }
  // PUT/PATCH/DELETE — treat as standard
  return 'standard';
}

// ---------------------------------------------------------------------------
// Gateway rate-limit middleware factory
// ---------------------------------------------------------------------------

export interface GatewayRateLimitOptions {
  redis: RedisClient;
  /**
   * HMAC secret for verifying x-internal-actor header.
   * Must match the secret used by the authenticate middleware.
   */
  actorContextSecret?: string;
  alarm?: RateLimitAlarm;
  logger?: {
    warn?(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
  };
}

export function createGatewayRateLimitMiddleware(options: GatewayRateLimitOptions) {
  const { redis, actorContextSecret = '', alarm, logger } = options;

  // Build per-tier limiters (one limiter per tier avoids a single hot key)
  const limiters = {
    guest: createRateLimiter({
      redis,
      windowMs: WINDOW_MS,
      limit: TIER_LIMITS.guest,
      alarm,
    }),
    traveler: createRateLimiter({
      redis,
      windowMs: WINDOW_MS,
      limit: TIER_LIMITS.traveler,
      alarm,
    }),
    support_agent: createRateLimiter({
      redis,
      windowMs: WINDOW_MS,
      limit: TIER_LIMITS.support_agent,
      alarm,
    }),
    system: createRateLimiter({
      redis,
      windowMs: WINDOW_MS,
      limit: TIER_LIMITS.system,
      alarm,
    }),
  } as const;

  return async function gatewayRateLimit(
    req: RequestLike,
    res: ResponseLike,
    next: NextFn,
  ): Promise<void> {
    const reference = req.correlationId ?? 'unknown';

    // Derive tier and actor identifier from the signed actor context
    let actorId: string | undefined;
    let tier: keyof typeof TIER_LIMITS = 'guest';

    const actorHeader = req.headers['x-internal-actor'];
    const raw = Array.isArray(actorHeader) ? actorHeader[0] : actorHeader;
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        const result = verifyActorContext(raw, actorContextSecret);
        if (result.ok) {
          actorId = result.context.sub;
          tier = tierFromRoles(result.context.roles);
        }
      } catch {
        // Header absent or invalid — treated as guest
      }
    }

    // Key: actorId for authenticated, client IP for guest
    const clientIp = (() => {
      const xff = req.headers['x-forwarded-for'];
      const raw2 = Array.isArray(xff) ? xff[0] : xff;
      if (raw2) return raw2.split(',')[0]?.trim() ?? 'unknown';
      return req.socket?.remoteAddress ?? 'unknown';
    })();

    const actorOrIp = actorId ?? clientIp;
    const costClass = resolveCostClass(req.method, req.path);
    const key = buildKey('gw', tier, actorOrIp, costClass);
    const cost = COST_CLASS[costClass];

    const limiter = limiters[tier];
    const result = await limiter.consume(key, cost);

    const resetEpoch = Math.floor(Date.now() / 1000) + result.resetAfterSeconds;
    res.set('RateLimit-Remaining', String(result.remaining));
    res.set('RateLimit-Reset', String(resetEpoch));

    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAfterSeconds);
      res.set('Retry-After', String(retryAfter));
      alarm?.onThrottled(tier, costClass);
      logger?.info(
        { tier, costClass, actorOrIp: actorId ? '[redacted]' : clientIp, reference },
        '[rateLimitMiddleware] Request throttled',
      );
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Please try again in ${retryAfter} seconds.`,
        },
        reference,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Per-service floor limiter factory (used in service bootstrap files)
// ---------------------------------------------------------------------------

export function createFloorRateLimiter(serviceScope: string, options: GatewayRateLimitOptions) {
  const { redis, alarm } = options;

  const floorLimiter = createRateLimiter({
    redis,
    windowMs: WINDOW_MS,
    limit: FLOOR_LIMIT,
    alarm,
  });

  return createRateLimitMiddleware({
    limiter: floorLimiter,
    scope: serviceScope,
    getCostClass: (req) => {
      const reqWithMethod = req as unknown as { method?: string; path?: string };
      return resolveCostClass(reqWithMethod.method ?? 'GET', reqWithMethod.path ?? '/');
    },
  });
}
