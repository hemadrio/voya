/**
 * Composable route guard factories (WO-023).
 *
 * These thin middlewares compose over the principal attached by
 * createBearerAuthMiddleware (or the actor set by requireAuth).
 *
 *   requireRoles("admin", "support") — 403 unless principal has ≥1 required role
 *   requirePermissions("booking:write") — 403 unless principal has ALL listed permissions
 *
 * Usage:
 *   router.delete("/resource/:id", bearerAuth, requireRoles("admin"), handler)
 *
 * Edge cases:
 *   - requireRoles() with zero arguments is a configuration error; throws at
 *     startup time (not silently allowing all).
 *   - requirePermissions() with zero arguments is a configuration error; throws
 *     at startup time.
 *   - A principal with zero roles satisfies requireAuth but fails all requireRoles.
 *   - Role and permission lookups use Set for O(1) evaluation.
 */

// ---------------------------------------------------------------------------
// Minimal framework-compatible types
// ---------------------------------------------------------------------------

interface PrincipalShape {
  userId: string;
  sessionId: string;
  tokenId: string;
  roles: string[];
  permissions: string[];
}

interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  principal?: PrincipalShape;
  actor?: { sub: string; sid: string; roles: string[]; jti: string };
}

interface GuardResponse {
  status(code: number): this;
  json(body: unknown): this;
  set(header: string, value: string): this;
  headersSent: boolean;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// requireRoles factory
// ---------------------------------------------------------------------------

/**
 * Returns middleware that passes when the authenticated principal has at least
 * one of the specified roles.  Returns 403 INSUFFICIENT_PERMISSIONS otherwise.
 *
 * @throws {Error} when called with zero roles (configuration error).
 */
export function requireRoles(...roles: string[]) {
  if (roles.length === 0) {
    throw new Error("requireRoles: at least one role must be specified. An empty list is a configuration error.");
  }

  const requiredSet = new Set(roles);

  return function rolesGuard(req: GuardRequest, res: GuardResponse, next: NextFn): void {
    const reference = req.correlationId ?? "unknown";
    const principal = req.principal ?? (req.actor ? asPrincipal(req.actor) : undefined);

    if (!principal) {
      res
        .set("WWW-Authenticate", 'Bearer realm="auth-service"')
        .status(401)
        .json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." }, reference });
      return;
    }

    const hasRole = principal.roles.some((r) => requiredSet.has(r));
    if (!hasRole) {
      res.status(403).json({
        error: {
          code: "INSUFFICIENT_PERMISSIONS",
          message: "You do not have the required role for this action.",
          required: roles,
        },
        reference,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// requirePermissions factory
// ---------------------------------------------------------------------------

/**
 * Returns middleware that passes when the authenticated principal holds ALL
 * of the specified permissions.  Returns 403 INSUFFICIENT_PERMISSIONS if any
 * permission is missing.
 *
 * @throws {Error} when called with zero permissions (configuration error).
 */
export function requirePermissions(...permissions: string[]) {
  if (permissions.length === 0) {
    throw new Error("requirePermissions: at least one permission must be specified. An empty list is a configuration error.");
  }

  return function permissionsGuard(req: GuardRequest, res: GuardResponse, next: NextFn): void {
    const reference = req.correlationId ?? "unknown";
    const principal = req.principal ?? (req.actor ? asPrincipal(req.actor) : undefined);

    if (!principal) {
      res
        .set("WWW-Authenticate", 'Bearer realm="auth-service"')
        .status(401)
        .json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." }, reference });
      return;
    }

    const principalPerms = new Set(principal.permissions);
    const missing = permissions.filter((p) => !principalPerms.has(p));

    if (missing.length > 0) {
      res.status(403).json({
        error: {
          code: "INSUFFICIENT_PERMISSIONS",
          message: "You do not have the required permissions for this action.",
          required: missing,
        },
        reference,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Helper — coerce ActorContext to PrincipalShape
// ---------------------------------------------------------------------------

function asPrincipal(actor: { sub: string; sid: string; roles: string[]; jti: string }): PrincipalShape {
  return {
    userId: actor.sub,
    sessionId: actor.sid,
    tokenId: actor.jti,
    roles: actor.roles,
    permissions: [],
  };
}
