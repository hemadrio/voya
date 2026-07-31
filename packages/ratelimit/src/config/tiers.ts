/**
 * Tiered rate-limit configuration.
 *
 * IMPORTANT: The numeric values below are ASSUMPTIONS documented for review.
 * They MUST be ratified by SRE and sponsors before going to production.
 * All values are intentionally below the WAF ceiling of 2000 requests per
 * 5 minutes per IP to ensure no tier can trigger a WAF block.
 *
 * Anchors from requirements:
 *   - WAF ceiling: 2000 req / 5 min / IP (hard upper bound).
 *   - Auth lockout: 5 failed logins in 15 min → ACCOUNT_TEMPORARILY_LOCKED.
 *
 * Cost class rationale:
 *   - cheap_read (cost=1): search queries, profile reads, session reads.
 *     These are cache-eligible and cheap to serve.
 *   - standard (cost=2): authenticated list operations, preference reads.
 *     Slightly heavier due to DB reads but still expected to be frequent.
 *   - expensive (cost=5): POST /bookings, POST /payments/intent, POST /chat.
 *     Involves external supplier calls, Stripe API, or LLM inference.
 *
 * Window: 5 minutes (300 000 ms) — balances burst headroom vs. abuse surface.
 *
 * Tier limit rationale (cost units per 5-minute window):
 *   - guest (120): generous for shared corporate NAT where many travelers
 *     share one IP, while staying well below WAF ceiling (2000).
 *     Allows 120 cheap reads OR 24 expensive ops per 5 min.
 *   - traveler (600): normal authenticated usage; allows 600 reads or
 *     120 expensive ops per 5 min.
 *   - support_agent (1200): agent console does bulk lookups; 2× traveler.
 *   - system (1800): queue consumers and internal jobs; high but still
 *     90% of WAF ceiling, leaving headroom for burst.
 *
 * Per-service floor limit (200 cost units / 5 min):
 *   Independent of tier, this conservative in-mesh limit prevents abuse
 *   of services accessed directly without going through the gateway.
 */

export const WINDOW_MS = 5 * 60 * 1000; // 5 minutes in ms

/**
 * Maximum cost units per 5-minute window by actor tier.
 * ASSUMPTION — pending SRE and sponsor ratification.
 */
export const TIER_LIMITS = {
  guest: 120,
  traveler: 600,
  support_agent: 1200,
  system: 1800,
} as const satisfies Record<string, number>;

export type ActorTier = keyof typeof TIER_LIMITS;

/**
 * Cost (in units) for each cost class.
 * ASSUMPTION — pending SRE and sponsor ratification.
 */
export const COST_CLASS = {
  /** Cheap: search reads, profile reads, session reads. */
  cheap_read: 1,
  /** Standard: authenticated lists, preference reads. */
  standard: 2,
  /** Expensive: booking creation, payment intent, chat/AI inference. */
  expensive: 5,
} as const satisfies Record<string, number>;

export type CostClass = keyof typeof COST_CLASS;

/**
 * Per-service floor limit (cost units / 5-minute window).
 * Applied independently of the gateway tier limit so direct in-mesh
 * requests are still throttled.
 * ASSUMPTION — pending SRE and sponsor ratification.
 */
export const FLOOR_LIMIT = 200;

/**
 * Auth lockout configuration.
 * ASSUMPTION — pending SRE and sponsor ratification.
 */
export const AUTH_LOCKOUT = {
  /** Maximum failed login attempts before account lockout. */
  maxFailures: 5,
  /** Window (ms) within which failures are counted. */
  windowMs: 15 * 60 * 1000, // 15 minutes
  /** Duration (ms) an account is locked after hitting the limit. */
  lockDurationMs: 15 * 60 * 1000, // 15 minutes
} as const;

/**
 * Derive the actor tier from role claims.
 * Falls back to 'guest' when the actor is unauthenticated or has no roles.
 */
export function tierFromRoles(roles: readonly string[] | undefined): ActorTier {
  if (!roles || roles.length === 0) return 'guest';
  if (roles.includes('system')) return 'system';
  if (roles.includes('support_agent')) return 'support_agent';
  if (roles.includes('traveler')) return 'traveler';
  return 'guest';
}

/**
 * Build a scoped rate-limit key.
 * Format: rl:{scope}:{tier}:{actorOrIp}:{costClass}
 */
export function buildKey(
  scope: string,
  tier: ActorTier,
  actorOrIp: string,
  costClass: CostClass,
): string {
  return `rl:${scope}:${tier}:${actorOrIp}:${costClass}`;
}
