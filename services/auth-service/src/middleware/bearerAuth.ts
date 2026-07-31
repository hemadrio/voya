/**
 * Bearer-token authentication middleware (WO-023).
 *
 * Responsibilities:
 *   1. Parse the Authorization header — require "Bearer <token>" exactly.
 *   2. Verify the JWT signature and claims via ITokenService.
 *   3. Confirm the session is still active (not revoked, not idle-expired),
 *      with a short-TTL in-process cache to avoid a DB round-trip on every hit.
 *   4. Confirm the user status is active (not suspended or deleted).
 *   5. Attach a typed RequestPrincipal to req.principal for downstream handlers.
 *
 * Error semantics:
 *   - Missing/malformed Authorization header → 401 UNAUTHENTICATED
 *   - Invalid JWT (signature, expiry, issuer, audience) → 401 INVALID_TOKEN
 *   - Revoked or expired session → 401 SESSION_REVOKED
 *   - Suspended/deleted user → 403 ACCOUNT_DISABLED
 *   - Unexpected repository/cache error → 500 INTERNAL_ERROR (fail closed)
 *
 * The WWW-Authenticate header is set on every 401 response.
 *
 * Security invariants:
 *   - Raw token values are NEVER logged.
 *   - Errors never reveal WHY authentication failed beyond the error code.
 *   - Middleware fails closed: any unexpected error returns 5xx, not 2xx.
 */

import type { ITokenService } from "../domain/TokenService.js";
import type { SessionRepository } from "../domain/SessionRepository.js";
import type { ISessionCache } from "./sessionCache.js";

// ---------------------------------------------------------------------------
// Minimal framework-compatible types (no @types/express at module level)
// ---------------------------------------------------------------------------

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  principal?: RequestPrincipalShape;
}

interface RequestPrincipalShape {
  userId: string;
  sessionId: string;
  tokenId: string;
  roles: string[];
  permissions: string[];
}

interface MinimalResponse {
  status(code: number): this;
  json(body: unknown): this;
  set(header: string, value: string): this;
  headersSent: boolean;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface BearerAuthDeps {
  tokenService: ITokenService;
  sessionRepository: SessionRepository;
  sessionCache: ISessionCache;
  /**
   * Resolve permissions for a given set of roles.
   * When omitted, permissions defaults to [].
   */
  resolvePermissions?: (roles: string[]) => Promise<string[]> | string[];
  /** Injected clock (ms) — defaults to Date.now. Override in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WWW_AUTHENTICATE_VALUE = 'Bearer realm="auth-service"';

function parseAuthorizationHeader(
  raw: string | string[] | undefined,
): { token: string } | null {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string" || header.length === 0) return null;

  // Exactly two whitespace-separated parts; scheme compared case-insensitively
  const spaceIdx = header.indexOf(" ");
  if (spaceIdx < 0) return null;

  const scheme = header.slice(0, spaceIdx);
  const credential = header.slice(spaceIdx + 1).trim();

  if (scheme.toLowerCase() !== "bearer") return null;
  if (credential.length === 0 || credential.includes(" ")) return null;

  return { token: credential };
}

function sendError(
  res: MinimalResponse,
  status: 401 | 403 | 500,
  code: string,
  message: string,
  reference: string,
  wwwAuthenticate?: string,
): void {
  if (wwwAuthenticate) {
    res.set("WWW-Authenticate", wwwAuthenticate);
  }
  res.status(status).json({ error: { code, message }, reference });
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Create an Express-compatible middleware that enforces Bearer authentication.
 * Rejects unauthenticated or insufficiently authorized requests.
 */
export function createBearerAuthMiddleware(deps: BearerAuthDeps) {
  const { tokenService, sessionRepository, sessionCache, resolvePermissions } = deps;
  const getNow = deps.now ?? (() => Date.now());

  return async function bearerAuth(
    req: MinimalRequest,
    res: MinimalResponse,
    next: NextFn,
  ): Promise<void> {
    const reference = req.correlationId ?? "unknown";

    // Step 1: Parse Authorization header — case-insensitive Bearer scheme.
    const parsed = parseAuthorizationHeader(req.headers["authorization"]);
    if (!parsed) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication required.", reference, WWW_AUTHENTICATE_VALUE);
      return;
    }

    // Step 2: Verify JWT signature and claims.
    let claims: ReturnType<typeof tokenService.verify>;
    try {
      claims = tokenService.verify(parsed.token);
    } catch {
      sendError(res, 401, "INVALID_TOKEN", "The provided token is invalid or has expired.", reference, WWW_AUTHENTICATE_VALUE);
      return;
    }

    if (!claims.sid) {
      sendError(res, 401, "INVALID_TOKEN", "Token is missing the sid claim.", reference, WWW_AUTHENTICATE_VALUE);
      return;
    }

    // Step 3: Session validity — cache-first, single DB query on miss (AC10).
    const cached = sessionCache.get(claims.sid);

    if (cached !== undefined) {
      // Cache hit — zero DB queries.
      if (!cached.valid) {
        sendError(res, 401, "SESSION_REVOKED", "Session has been revoked or expired.", reference, WWW_AUTHENTICATE_VALUE);
        return;
      }
      req.principal = {
        userId: cached.userId,
        sessionId: claims.sid,
        tokenId: claims.jti,
        roles: cached.roles,
        permissions: cached.permissions,
      };
      next();
      return;
    }

    // Cache miss — ONE database query fetches session + user status via JOIN.
    let row: import("../domain/SessionRepository.js").SessionWithUserStatus | null;
    try {
      row = await sessionRepository.findByIdWithUserStatus(claims.sid);
    } catch {
      next(new Error("Session lookup failed"));
      return;
    }

    // Session missing, revoked, or idle-expired.
    if (!row || row.revokedAt !== null || row.expiresAt <= new Date(getNow())) {
      sessionCache.set(claims.sid, { userId: claims.sub, valid: false, roles: [], permissions: [] });
      sendError(res, 401, "SESSION_REVOKED", "Session has been revoked or expired.", reference, WWW_AUTHENTICATE_VALUE);
      return;
    }

    // Step 4: User account status check (from the same JOIN row — no second query).
    if (row.userStatus === "suspended" || row.userStatus === "deleted") {
      sessionCache.set(claims.sid, { userId: row.userId, valid: false, roles: [], permissions: [] });
      res.status(403).json({
        error: { code: "ACCOUNT_DISABLED", message: "This account has been disabled." },
        reference,
      });
      return;
    }

    // Step 5: Resolve permissions and populate cache for subsequent requests.
    const roles = claims.roles ?? [];
    let permissions: string[] = [];
    if (resolvePermissions) {
      try {
        permissions = await resolvePermissions(roles);
      } catch {
        // Non-fatal: proceed with empty permissions so the request isn't blocked
        // by a permission-resolution failure (guards will fail separately if needed).
        permissions = [];
      }
    }

    sessionCache.set(claims.sid, { userId: row.userId, valid: true, roles, permissions });

    req.principal = {
      userId: row.userId,
      sessionId: claims.sid,
      tokenId: claims.jti,
      roles,
      permissions,
    };

    next();
  };
}

/**
 * optionalAuth — attaches a principal when a valid token is present but
 * continues anonymously (req.principal = undefined) when the Authorization
 * header is absent.
 *
 * IMPORTANT: a *present but invalid* token still returns 401 — optionalAuth
 * does NOT silently downgrade an invalid token to anonymous.
 */
export function createOptionalAuthMiddleware(deps: BearerAuthDeps) {
  const inner = createBearerAuthMiddleware(deps);

  return async function optionalAuth(
    req: MinimalRequest,
    res: MinimalResponse,
    next: NextFn,
  ): Promise<void> {
    const raw = req.headers["authorization"];
    const header = Array.isArray(raw) ? raw[0] : raw;

    // No Authorization header → continue as anonymous.
    if (!header || header.trim().length === 0) {
      next();
      return;
    }

    // Header is present → run full verification.
    await inner(req, res, next);
  };
}

// Re-export the parse helper for testing.
export { parseAuthorizationHeader };
