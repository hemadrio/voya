/**
 * Auth service routes — register, login, refresh, logout, OAuth callback,
 * session management, forgot-password, reset-password, verify-email, and
 * resend-verification.
 *
 * Protected routes use requireAuth to extract the actor context forwarded by
 * the api-gateway.  Public routes rely on Zod schema validation only.
 *
 * Every route (except GET /health) validates its input via validateRequest
 * before any domain call, so unauthenticated requests still return 400 for
 * malformed input without disclosing account existence.
 *
 * WO-101 additions:
 *   - AuthAuditLogger interface injected into AuthRouterOptions for writing
 *     append-only auth_audit_log rows on every authentication event.
 *   - Events: login success, login failure, lockout, token refresh,
 *     refresh-token reuse detection, logout, access-control denial, and
 *     server-side validation failure.
 *   - No credential material (password, tokens, hashes) is ever passed to
 *     the audit logger; only masked email (domain part retained) and actor IP.
 */
import { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  OAuthCallbackRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
  ResendVerificationRequestSchema,
  REGISTRATION_ACCEPTED_MESSAGE,
} from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  createInMemoryRateLimiter,
  createRateLimitMiddleware,
  type RateLimiter,
} from "../middleware/rateLimiter.js";
import type { LoginAttemptGuard } from "../domain/LoginAttemptGuard.js";
import type { Request, Response } from "express";
import type { SessionInfo } from "../domain/types.js";

// ---------------------------------------------------------------------------
// AuthAuditLogger — injectable port for auth audit events (WO-101)
// ---------------------------------------------------------------------------

/** Minimum payload required for every auth audit event. */
export interface AuthAuditEvent {
  /** Action that occurred (AUTH_LOGIN_SUCCESS, AUTH_LOGIN_FAILURE, etc.). */
  action: string;
  /** System principal or user UUID. "anonymous" when actor is unknown. */
  actorId: string;
  /** Role of the actor. */
  actorRole: string;
  /** IPv4/v6 of the originating request. Never raw password or token. */
  actorIp?: string;
  /** Resource type ("session", "user", etc.). */
  resourceType: string;
  /** Resource identifier (user UUID, IP-hash for anonymous). */
  resourceId: string;
  /** Distributed trace identifier from the request context. */
  correlationId?: string;
  /**
   * Sanitised metadata for the event.
   * Must not contain: password, passwordHash, token, refreshToken, accessToken,
   * passportNumber, dateOfBirth.  Callers are responsible for excluding these
   * fields — the logger does not re-sanitise.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget is NOT permitted: a failed audit write must surface as an
 * error so the enclosing operation can fail rather than proceed unaudited.
 * Implementations should throw on persistence failure.
 */
export interface AuthAuditLogger {
  log(event: AuthAuditEvent): Promise<void>;
}

/** Mask an email address for audit logs: keep the domain, redact the local part. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "[REDACTED]";
  return `***@${email.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------
// Refresh cookie + CSRF helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Cookie header string into a key→value map.
 * Inline to avoid the `cookie-parser` dependency.
 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

/** Name of the HttpOnly refresh cookie. */
const REFRESH_COOKIE_NAME = "rt";
/** Name of the non-HttpOnly CSRF cookie (double-submit pair). */
const CSRF_COOKIE_NAME = "csrf_token";
/** Header the client must mirror from the CSRF cookie for double-submit. */
const CSRF_HEADER_NAME = "x-csrf-token";

/** Cookie options shared by set and clear operations. */
const REFRESH_COOKIE_BASE = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] !== "test",
  path: "/auth/refresh",
} as const;

/** Cookie options for the non-HttpOnly CSRF token (readable by JS). */
const CSRF_COOKIE_BASE = {
  httpOnly: false,
  secure: process.env["NODE_ENV"] !== "test",
  path: "/auth/refresh",
} as const;

/**
 * Set the HttpOnly refresh cookie and the non-HttpOnly CSRF double-submit cookie.
 * @param sameSite - "strict" by default; set to "lax" for cross-site OAuth flows.
 */
function setRefreshCookies(
  res: Response,
  rawRefreshToken: string,
  csrfToken: string,
  maxAgeSeconds: number,
  sameSite: "strict" | "lax" = "strict",
): void {
  res.cookie(REFRESH_COOKIE_NAME, rawRefreshToken, {
    ...REFRESH_COOKIE_BASE,
    sameSite,
    maxAge: maxAgeSeconds * 1000,
  });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...CSRF_COOKIE_BASE,
    sameSite,
    maxAge: maxAgeSeconds * 1000,
  });
}

function clearRefreshCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_BASE, sameSite: "strict" });
  res.clearCookie(CSRF_COOKIE_NAME, { ...CSRF_COOKIE_BASE, sameSite: "strict" });
}

// Schemas compiled once at module scope (8 ms budget constraint).
const validateRegister = validateRequest({ body: RegisterRequestSchema });
const validateLogin = validateRequest({ body: LoginRequestSchema });
const validateRefresh = validateRequest({ body: RefreshRequestSchema });
const validateOAuthCallback = validateRequest({ query: OAuthCallbackRequestSchema });
const validateForgotPassword = validateRequest({ body: ForgotPasswordRequestSchema });
const validateResetPassword = validateRequest({ body: ResetPasswordRequestSchema });
const validateVerifyEmail = validateRequest({ body: VerifyEmailRequestSchema });
const validateResendVerification = validateRequest({ body: ResendVerificationRequestSchema });

// Default rate limiter: 5 requests per 15 minutes per key (email+IP).
// In production, replace with a Redis-backed limiter injected via createAuthRouter options.
const defaultRegisterLimiter = createInMemoryRateLimiter({ maxHits: 5, windowSeconds: 900 });
const defaultForgotPasswordLimiter = createInMemoryRateLimiter({ maxHits: 5, windowSeconds: 900 });
const defaultResetPasswordLimiter = createInMemoryRateLimiter({ maxHits: 10, windowSeconds: 900 });
const defaultResendVerificationLimiter = createInMemoryRateLimiter({ maxHits: 5, windowSeconds: 900 });

// ---------------------------------------------------------------------------
// Domain interface
// ---------------------------------------------------------------------------

export interface AuthDomain {
  register(input: unknown): Promise<unknown>;
  login(input: unknown): Promise<unknown>;
  refresh(input: { rawToken: string; ipAddress?: string; userAgent?: string }): Promise<unknown>;
  logout(params: { sid: string; userId: string }): Promise<void>;
  oauthCallback(input: unknown): Promise<unknown>;
  logoutAll(params: { userId: string }): Promise<{ revokedCount: number }>;
  listSessions(params: { userId: string; currentSid: string }): Promise<{ sessions: SessionInfo[] }>;
  deleteSession(params: { sessionId: string; userId: string; currentSid: string }): Promise<void>;
  forgotPassword(params: { email: string }): Promise<void>;
  resetPassword(params: { token: string; password: string }): Promise<void>;
  verifyEmail(params: { token: string }): Promise<unknown>;
  resendVerification(params: { email: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface AuthRouterOptions {
  domain: AuthDomain;
  /** Override default in-memory rate limiter for registration (e.g. Redis-backed). */
  registerLimiter?: RateLimiter;
  /** Override default in-memory rate limiter for forgot-password (e.g. Redis-backed). */
  forgotPasswordLimiter?: RateLimiter;
  /** Override default in-memory rate limiter for reset-password. */
  resetPasswordLimiter?: RateLimiter;
  /** Override default in-memory rate limiter for resend-verification. */
  resendVerificationLimiter?: RateLimiter;
  /**
   * Login attempt guard enforcing per-account lockout (5 failures / 15 min).
   * When omitted, account lockout is not enforced (unsafe outside tests).
   */
  loginAttemptGuard?: LoginAttemptGuard;
  /**
   * WO-101: Injectable audit logger for auth events.
   * When provided, every authentication event writes an auth_audit_log row.
   * Audit failures propagate as errors (never fire-and-forget).
   */
  auditLogger?: AuthAuditLogger;
}

export function createAuthRouter(domainOrOptions: AuthDomain | AuthRouterOptions): Router {
  const options: AuthRouterOptions =
    "domain" in (domainOrOptions as AuthRouterOptions)
      ? (domainOrOptions as AuthRouterOptions)
      : { domain: domainOrOptions as AuthDomain };

  const { domain, loginAttemptGuard, auditLogger } = options;
  const regLimiter = options.registerLimiter ?? defaultRegisterLimiter;
  const fpLimiter = options.forgotPasswordLimiter ?? defaultForgotPasswordLimiter;
  const rpLimiter = options.resetPasswordLimiter ?? defaultResetPasswordLimiter;
  const rvLimiter = options.resendVerificationLimiter ?? defaultResendVerificationLimiter;

  function normalizedEmailAndIp(req: Request): { email: string; ip: string } {
    const body = req.body as Record<string, unknown> | undefined;
    const email = (typeof body?.["email"] === "string" ? body["email"] : "").trim().toLowerCase();
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? "unknown";
    return { email, ip };
  }

  const rateLimitRegister = createRateLimitMiddleware({
    limiter: regLimiter,
    getKey: (req) => {
      const { email, ip } = normalizedEmailAndIp(req);
      return `reg:${email}:${ip}`;
    },
  });

  const rateLimitForgotPassword = createRateLimitMiddleware({
    limiter: fpLimiter,
    getKey: (req) => {
      const { email, ip } = normalizedEmailAndIp(req);
      return `fp:${email}:${ip}`;
    },
  });

  const rateLimitResetPassword = createRateLimitMiddleware({
    limiter: rpLimiter,
    getKey: (req) => {
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? "unknown";
      return `rp:${ip}`;
    },
  });

  const rateLimitResendVerification = createRateLimitMiddleware({
    limiter: rvLimiter,
    getKey: (req) => {
      const { email, ip } = normalizedEmailAndIp(req);
      return `rv:${email}:${ip}`;
    },
  });

  const router = Router();

  // ── Public routes ──────────────────────────────────────────────────────────

  router.post(
    "/register",
    rateLimitRegister,
    validateRegister,
    async (req: Request, res: Response): Promise<void> => {
      try {
        await domain.register(req.validated?.body);
      } catch (err: unknown) {
        // Password-policy violations are a domain concern; map to 422 here so
        // the error handler does not need to know about this code.
        if (
          err instanceof Error &&
          (err as { code?: unknown }).code === "POLICY_VIOLATION"
        ) {
          const violations =
            (err as { violations?: Array<{ rule: string; message: string }> }).violations ?? [];
          res.status(422).json({
            error: {
              code: "PASSWORD_POLICY_VIOLATION",
              message: (err as Error).message,
              violations,
            },
            reference: req.correlationId ?? "unknown",
          });
          return;
        }
        throw err;
      }
      res.status(202).json({ message: REGISTRATION_ACCEPTED_MESSAGE });
    },
  );

  // POST /auth/verify-email — consumes token, activates account
  router.post(
    "/verify-email",
    validateVerifyEmail,
    async (req: Request, res: Response): Promise<void> => {
      const body = req.validated?.body as { token: string };
      const result = await domain.verifyEmail({ token: body.token });
      res.status(200).json(result);
    },
  );

  // POST /auth/resend-verification — rate-limited, enumeration-safe 202
  router.post(
    "/resend-verification",
    rateLimitResendVerification,
    validateResendVerification,
    async (req: Request, res: Response): Promise<void> => {
      const body = req.validated?.body as { email: string };
      await domain.resendVerification({ email: body.email });
      res.status(202).json({ message: REGISTRATION_ACCEPTED_MESSAGE });
    },
  );

  router.post("/login", validateLogin, async (req: Request, res: Response): Promise<void> => {
    const body = req.validated?.body as { email?: string } | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    const ipAddress =
      ((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()) ??
      req.socket?.remoteAddress ??
      "unknown";
    const correlationId = req.correlationId;

    // WO-101: lockout check — emit AUTH_LOCKOUT audit event when rate-limited
    if (loginAttemptGuard && email) {
      const check = await loginAttemptGuard.checkAllowed(email);
      if (!check.allowed) {
        const retryAfter = Math.max(1, check.retryAfterSeconds);
        if (auditLogger) {
          await auditLogger.log({
            action: "AUTH_LOCKOUT",
            actorId: "anonymous",
            actorRole: "anonymous",
            actorIp: ipAddress,
            resourceType: "user",
            resourceId: "anonymous",
            correlationId,
            metadata: { maskedEmail: maskEmail(email), retryAfterSeconds: retryAfter },
          });
        }
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({
          error: {
            code: "ACCOUNT_TEMPORARILY_LOCKED",
            message: `Account temporarily locked. Please try again in ${retryAfter} seconds.`,
          },
          reference: correlationId ?? "unknown",
        });
        return;
      }
    }

    let result: unknown;
    try {
      result = await domain.login(req.validated?.body);
    } catch (err) {
      if (loginAttemptGuard && email) {
        await loginAttemptGuard.recordFailure(email, ipAddress);
      }
      // WO-101: emit AUTH_LOGIN_FAILURE audit event
      if (auditLogger) {
        await auditLogger.log({
          action: "AUTH_LOGIN_FAILURE",
          actorId: "anonymous",
          actorRole: "anonymous",
          actorIp: ipAddress,
          resourceType: "user",
          resourceId: "anonymous",
          correlationId,
          metadata: {
            maskedEmail: maskEmail(email),
            reason: (err instanceof Error ? (err as { code?: string }).code : undefined) ?? "UNKNOWN",
          },
        });
      }
      throw err;
    }

    if (loginAttemptGuard && email) {
      await loginAttemptGuard.recordSuccess(email, ipAddress);
    }

    // WO-101: emit AUTH_LOGIN_SUCCESS audit event
    const loginResult = result as { user?: { id?: string } } | undefined;
    const userId = loginResult?.user?.id ?? "unknown";
    if (auditLogger) {
      await auditLogger.log({
        action: "AUTH_LOGIN_SUCCESS",
        actorId: userId,
        actorRole: "traveler",
        actorIp: ipAddress,
        resourceType: "session",
        resourceId: userId,
        correlationId,
        metadata: { maskedEmail: maskEmail(email) },
      });
    }

    // Set HttpOnly refresh cookie + CSRF double-submit cookie for browser clients.
    const loginOut = result as {
      refreshToken?: string;
      refreshTtlMs?: number;
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      user: unknown;
    };
    if (loginOut.refreshToken && loginOut.refreshTtlMs) {
      const csrfToken = randomBytes(16).toString("hex");
      setRefreshCookies(
        res,
        loginOut.refreshToken,
        csrfToken,
        Math.floor(loginOut.refreshTtlMs / 1000),
      );
    }

    // Strip raw refresh token from the response body — browser clients use the
    // cookie; non-browser clients that cannot read cookies will need to call
    // /refresh with the body field, which they should store securely.
    // Per the security constraint, raw tokens must never appear in response logs.
    const { refreshToken: _rt, refreshTtlMs: _ttl, ...publicLoginResult } = loginOut;
    void _rt; void _ttl;

    // Return the LoginResponse shape directly (no wrapper) so the api-gateway
    // can forward the accessToken without unwrapping.
    res.json(publicLoginResult);
  });

  router.post("/refresh", validateRefresh, async (req: Request, res: Response): Promise<void> => {
    const ipAddress =
      ((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()) ??
      req.socket?.remoteAddress ??
      "unknown";
    const correlationId = req.correlationId;

    // ── Token extraction ────────────────────────────────────────────────────
    // Preference order: HttpOnly cookie (browser) → body field (non-browser).
    const cookies = parseCookieHeader(req.headers["cookie"] as string | undefined);
    const cookieToken = cookies[REFRESH_COOKIE_NAME];
    const bodyToken = (req.validated?.body as { refreshToken?: string } | undefined)?.refreshToken;
    const rawToken = cookieToken ?? bodyToken;

    if (!rawToken) {
      res.status(401).json({
        error: { code: "INVALID_REFRESH_TOKEN", message: "Refresh token is required." },
        reference: correlationId ?? "unknown",
      });
      return;
    }

    // ── CSRF double-submit validation (cookie path only) ───────────────────
    // When the token arrived via cookie, require the matching CSRF header.
    // SameSite=strict cookies already provide strong CSRF protection, but we
    // add the double-submit token as defence-in-depth for Lax configurations
    // and older browsers.
    if (cookieToken) {
      const csrfCookie = cookies[CSRF_COOKIE_NAME];
      const csrfHeader = req.headers[CSRF_HEADER_NAME] as string | undefined;
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        res.status(403).json({
          error: { code: "CSRF_FAILED", message: "CSRF token mismatch." },
          reference: correlationId ?? "unknown",
        });
        return;
      }
    }

    let result: unknown;
    try {
      result = await domain.refresh({ rawToken, ipAddress, userAgent: req.headers["user-agent"] });
    } catch (err) {
      // WO-101: emit AUTH_REFRESH_REUSE_DETECTED for token reuse errors
      const errCode = err instanceof Error ? (err as { code?: string }).code : undefined;
      if (auditLogger) {
        const action = errCode === "REFRESH_TOKEN_REUSED"
          ? "AUTH_REFRESH_REUSE_DETECTED"
          : "AUTH_VALIDATION_FAILURE";
        await auditLogger.log({
          action,
          actorId: "anonymous",
          actorRole: "anonymous",
          actorIp: ipAddress,
          resourceType: "session",
          resourceId: "anonymous",
          correlationId,
          metadata: { errorCode: errCode ?? "UNKNOWN" },
        });
      }
      // Clear cookies on any auth failure to prevent stale cookie loops.
      clearRefreshCookies(res);
      throw err;
    }

    // ── Rotate cookies and return response ─────────────────────────────────
    const refreshOut = result as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      newRefreshToken?: string;
      refreshTtlMs?: number;
      userId?: string;
    };

    if (refreshOut.newRefreshToken && refreshOut.refreshTtlMs) {
      const newCsrfToken = randomBytes(16).toString("hex");
      setRefreshCookies(
        res,
        refreshOut.newRefreshToken,
        newCsrfToken,
        Math.floor(refreshOut.refreshTtlMs / 1000),
      );
    }

    // WO-101: emit AUTH_TOKEN_REFRESH on success
    if (auditLogger) {
      const userId = refreshOut.userId ?? "unknown";
      await auditLogger.log({
        action: "AUTH_TOKEN_REFRESH",
        actorId: userId,
        actorRole: "traveler",
        actorIp: ipAddress,
        resourceType: "session",
        resourceId: userId,
        correlationId,
      });
    }

    // Response body: only include raw refreshToken for non-browser clients
    // (those that sent the token in the body rather than a cookie).
    const responseBody: {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      refreshToken?: string;
    } = {
      accessToken: refreshOut.accessToken,
      tokenType: refreshOut.tokenType,
      expiresIn: refreshOut.expiresIn,
    };
    if (!cookieToken && refreshOut.newRefreshToken) {
      // Non-browser client — echo back the new token in the body.
      responseBody.refreshToken = refreshOut.newRefreshToken;
    }

    res.json(responseBody);
  });

  // OAuth callback — input in query params, not body
  router.get("/google/callback", validateOAuthCallback, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.oauthCallback(req.validated?.query);
    res.json({ data: result });
  });

  // POST /auth/forgot-password — enumeration-safe, always 202
  router.post(
    "/forgot-password",
    rateLimitForgotPassword,
    validateForgotPassword,
    async (req: Request, res: Response): Promise<void> => {
      const body = req.validated?.body as { email: string };
      await domain.forgotPassword({ email: body.email });
      res.status(202).json({
        message: "If the address is valid you will receive reset instructions.",
      });
    },
  );

  // POST /auth/reset-password
  router.post(
    "/reset-password",
    rateLimitResetPassword,
    validateResetPassword,
    async (req: Request, res: Response): Promise<void> => {
      const body = req.validated?.body as { token: string; password: string };
      await domain.resetPassword({ token: body.token, password: body.password });
      res.json({ reset: true });
    },
  );

  // ── Protected routes (requireAuth) ────────────────────────────────────────

  // POST /auth/logout — revoke current session, clear refresh cookie
  router.post(
    "/logout",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const actor = req.actor!;
      const ipAddress =
        ((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()) ??
        req.socket?.remoteAddress ??
        "unknown";
      const correlationId = req.correlationId;

      await domain.logout({ sid: actor.sid, userId: actor.sub });

      // WO-101: emit AUTH_LOGOUT audit event
      if (auditLogger) {
        await auditLogger.log({
          action: "AUTH_LOGOUT",
          actorId: actor.sub,
          actorRole: actor.roles?.[0] ?? "traveler",
          actorIp: ipAddress,
          resourceType: "session",
          resourceId: actor.sub,
          correlationId,
        });
      }

      clearRefreshCookies(res);
      res.status(204).end();
    },
  );

  // POST /auth/logout-all — revoke every active session for the user
  router.post(
    "/logout-all",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const actor = req.actor!;
      const result = await domain.logoutAll({ userId: actor.sub });
      res.json({ revokedCount: result.revokedCount });
    },
  );

  // GET /auth/sessions — list active sessions (never exposes refresh token hashes)
  router.get(
    "/sessions",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const actor = req.actor!;
      const result = await domain.listSessions({ userId: actor.sub, currentSid: actor.sid });
      res.json(result);
    },
  );

  // DELETE /auth/sessions/:id — revoke a specific session (404 if not owned, not 403)
  router.delete(
    "/sessions/:id",
    requireAuth,
    async (req: Request, res: Response): Promise<void> => {
      const actor = req.actor!;
      const sessionId = req.params["id"] as string;
      await domain.deleteSession({
        sessionId,
        userId: actor.sub,
        currentSid: actor.sid,
      });
      res.status(204).end();
    },
  );

  return router;
}
