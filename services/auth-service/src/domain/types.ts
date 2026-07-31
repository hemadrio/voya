/**
 * Shared domain types for the auth-service.
 *
 * These types are used by the domain layer and routes but must not import
 * Express or PrismaClient directly (hexagonal architecture constraint).
 */

// ---------------------------------------------------------------------------
// Actor context (parsed from x-internal-actor header set by the api-gateway)
// ---------------------------------------------------------------------------

export interface ActorContext {
  /** Authenticated user ID (JWT sub claim). */
  sub: string;
  /** Session ID (JWT sid claim). */
  sid: string;
  /** Role claims. */
  roles: string[];
  /** JWT ID — used for denylist lookup. */
  jti: string;
}

// ---------------------------------------------------------------------------
// Session info returned by the session listing endpoint
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}
