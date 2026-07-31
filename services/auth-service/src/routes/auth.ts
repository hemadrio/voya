/**
 * Auth service routes — register, login, refresh, logout, OAuth callback,
 * session management, forgot-password, and reset-password.
 *
 * Protected routes use requireAuth to extract the actor context forwarded by
 * the api-gateway.  Public routes (register, login, refresh, forgot/reset
 * password) rely on Zod schema validation only.
 *
 * Every route (except GET /health) validates its input via validateRequest
 * before any domain call, so unauthenticated requests still return 400 for
 * malformed input without disclosing account existence.
 */
import { Router } from "express";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  OAuthCallbackRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
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

// Schemas compiled once at module scope (8 ms budget constraint).
const validateRegister = validateRequest({ body: RegisterRequestSchema });
const validateLogin = validateRequest({ body: LoginRequestSchema });
const validateRefresh = validateRequest({ body: RefreshRequestSchema });
const validateOAuthCallback = validateRequest({ query: OAuthCallbackRequestSchema });
const validateForgotPassword = validateRequest({ body: ForgotPasswordRequestSchema });
const validateResetPassword = validateRequest({ body: ResetPasswordRequestSchema });

// Default rate limiter: 5 requests per 15 minutes per key (email+IP).
// In production, replace with a Redis-backed limiter injected via createAuthRouter options.
const defaultForgotPasswordLimiter = createInMemoryRateLimiter({ maxHits: 5, windowSeconds: 900 });
const defaultResetPasswordLimiter = createInMemoryRateLimiter({ maxHits: 10, windowSeconds: 900 });

// ---------------------------------------------------------------------------
// Domain interface
// ---------------------------------------------------------------------------

export interface AuthDomain {
  register(input: unknown): Promise<unknown>;
  login(input: unknown): Promise<unknown>;
  refresh(input: unknown): Promise<unknown>;
  logout(params: { sid: string; userId: string }): Promise<void>;
  oauthCallback(input: unknown): Promise<unknown>;
  logoutAll(params: { userId: string }): Promise<{ revokedCount: number }>;
  listSessions(params: { userId: string; currentSid: string }): Promise<{ sessions: SessionInfo[] }>;
  deleteSession(params: { sessionId: string; userId: string; currentSid: string }): Promise<void>;
  forgotPassword(params: { email: string }): Promise<void>;
  resetPassword(params: { token: string; password: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Refresh cookie constants — same attributes used to set and clear the cookie
// ---------------------------------------------------------------------------

const REFRESH_COOKIE_NAME = "refresh_token";
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] !== "test",
  sameSite: "strict" as const,
  path: "/auth/refresh",
};

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface AuthRouterOptions {
  domain: AuthDomain;
  /** Override default in-memory rate limiter for forgot-password (e.g. Redis-backed). */
  forgotPasswordLimiter?: RateLimiter;
  /** Override default in-memory rate limiter for reset-password. */
  resetPasswordLimiter?: RateLimiter;
  /**
   * Login attempt guard enforcing per-account lockout (5 failures / 15 min).
   * When omitted, account lockout is not enforced (unsafe outside tests).
   */
  loginAttemptGuard?: LoginAttemptGuard;
}

export function createAuthRouter(domainOrOptions: AuthDomain | AuthRouterOptions): Router {
  const options: AuthRouterOptions =
    "domain" in (domainOrOptions as AuthRouterOptions)
      ? (domainOrOptions as AuthRouterOptions)
      : { domain: domainOrOptions as AuthDomain };

  const { domain, loginAttemptGuard } = options;
  const fpLimiter = options.forgotPasswordLimiter ?? defaultForgotPasswordLimiter;
  const rpLimiter = options.resetPasswordLimiter ?? defaultResetPasswordLimiter;

  const rateLimitForgotPassword = createRateLimitMiddleware({
    limiter: fpLimiter,
    getKey: (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      const email = (typeof body?.["email"] === "string" ? body["email"] : "").toLowerCase();
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? "unknown";
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

  const router = Router();

  // ── Public routes ──────────────────────────────────────────────────────────

  router.post("/register", validateRegister, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.register(req.validated?.body);
    res.status(201).json({ data: result });
  });

  router.post("/login", validateLogin, async (req: Request, res: Response): Promise<void> => {
    const body = req.validated?.body as { email?: string } | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    const ipAddress =
      ((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()) ??
      req.socket?.remoteAddress ??
      "unknown";

    if (loginAttemptGuard && email) {
      const check = await loginAttemptGuard.checkAllowed(email);
      if (!check.allowed) {
        const retryAfter = Math.max(1, check.retryAfterSeconds);
        res.set("Retry-After", String(retryAfter));
        res.status(429).json({
          error: {
            code: "ACCOUNT_TEMPORARILY_LOCKED",
            message: `Account temporarily locked. Please try again in ${retryAfter} seconds.`,
          },
          reference: req.correlationId ?? "unknown",
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
      throw err;
    }

    if (loginAttemptGuard && email) {
      await loginAttemptGuard.recordSuccess(email, ipAddress);
    }

    res.json({ data: result });
  });

  router.post("/refresh", validateRefresh, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.refresh(req.validated?.body);
    res.json({ data: result });
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
      await domain.logout({ sid: actor.sid, userId: actor.sub });
      clearRefreshCookie(res);
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
