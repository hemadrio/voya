/**
 * Authorization middleware — deny by default.
 *
 * Every route must be guarded with either requireRole() or allowGuest().
 * A route registry tracks which routes have been registered; the startup
 * assertion assertAllRoutesGuarded() verifies completeness at boot.
 *
 * Guest allow-list (hardcoded, requires code change + test update to modify):
 *   POST /v1/flights/search
 *   POST /v1/hotels/search
 *   POST /v1/cars/search
 *   POST /v1/chat
 */

// ---------------------------------------------------------------------------
// Types (inline — avoids @types/express import in the shared package)
// ---------------------------------------------------------------------------

type Role = 'traveler' | 'support_agent' | 'system';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  actor?: {
    sub: string;
    sid: string;
    roles: string[];
    jti: string;
    issuedAt?: number;
  };
  correlationId?: string;
}

interface ResponseLike {
  status(code: number): this;
  json(body: unknown): this;
}

type NextFn = (err?: unknown) => void;
type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFn) => void;

// ---------------------------------------------------------------------------
// Route guard registry
// ---------------------------------------------------------------------------

export type GuardType = 'requireRole' | 'allowGuest';

interface GuardEntry {
  type: GuardType;
  roles?: Role[];
}

const _guardRegistry = new Map<string, GuardEntry>();

/** Register a route guard. Idempotent for identical registrations. */
export function registerRouteGuard(
  method: string,
  path: string,
  type: GuardType,
  roles?: Role[],
): void {
  _guardRegistry.set(`${method.toUpperCase()}:${path}`, { type, roles });
}

/** Read-only view of the registry for tests and startup assertions. */
export function getGuardRegistry(): ReadonlyMap<string, GuardEntry> {
  return _guardRegistry;
}

/**
 * Startup assertion — verifies every declared route has a registered guard.
 * Call during service initialisation with the full list of route keys.
 * Throws on the first unguarded route found.
 *
 * @param routes Array of [method, path] pairs (e.g. [['GET', '/:bookingId']])
 */
export function assertAllRoutesGuarded(routes: Array<[string, string]>): void {
  const missing: string[] = [];
  for (const [method, path] of routes) {
    const key = `${method.toUpperCase()}:${path}`;
    if (!_guardRegistry.has(key)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[authorize] Service startup failed: the following routes have no guard registration:\n  ${missing.join('\n  ')}`,
    );
  }
}

/** Clear the registry — test helper only. Never call in production code. */
export function _clearGuardRegistry(): void {
  _guardRegistry.clear();
}

// ---------------------------------------------------------------------------
// Guest allow-list (exactly four routes — requires explicit code change to modify)
// ---------------------------------------------------------------------------

export const GUEST_ROUTES: ReadonlySet<string> = new Set([
  'POST:/v1/flights/search',
  'POST:/v1/hotels/search',
  'POST:/v1/cars/search',
  'POST:/v1/chat',
]);

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

function makeErrorBody(code: string, message: string, reference?: string) {
  return { error: { code, message }, reference };
}

/**
 * Middleware that requires the actor to have at least one of the specified
 * roles.  Returns 401 if there is no actor context (unauthenticated), or 403
 * if the actor's roles do not intersect the required set.
 *
 * Also registers the route in the guard registry if method + path are provided.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return function requireRoleMiddleware(req, res, next) {
    const actor = req.actor;
    const reference = req.correlationId;

    if (!actor) {
      res.status(401).json(
        makeErrorBody('UNAUTHENTICATED', 'Authentication required', reference),
      );
      return;
    }

    const hasRole = (actor.roles as string[]).some(r =>
      (roles as string[]).includes(r),
    );
    if (!hasRole) {
      res.status(403).json(
        makeErrorBody('FORBIDDEN', 'Insufficient permissions', reference),
      );
      return;
    }

    next();
  };
}

/**
 * Pass-through middleware for routes on the guest allow-list.
 * Marks the request as explicitly allowed without authentication.
 */
export function allowGuest(): RequestHandler {
  return function allowGuestMiddleware(_req, _res, next) {
    next();
  };
}

/**
 * Global deny-by-default middleware — use as the LAST middleware before the
 * error handler.  Returns 403 for any request that reached this point without
 * a requireRole or allowGuest guard having run successfully.
 *
 * In practice, this is only reached by routes that were never given a guard.
 * Properly guarded routes either call next() (allowed) or return a 401/403
 * before this middleware runs.
 */
export function denyByDefault(): RequestHandler {
  return function denyByDefaultMiddleware(req, res, _next) {
    const reference = req.correlationId;
    res.status(403).json(makeErrorBody('FORBIDDEN', 'Route not permitted', reference));
  };
}
