/**
 * Auth service routes — register, login, refresh, logout, OAuth callback.
 *
 * Every route (except GET /health) validates its input via validateRequest
 * before any domain call, so unauthenticated requests still return 400 for
 * malformed input without disclosing account existence.
 *
 * OAuthCallbackRequestSchema validates query params (code + state).
 */
import { Router } from "express";
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  LogoutRequestSchema,
  OAuthCallbackRequestSchema,
} from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";

// Schemas compiled once at module scope.
const validateRegister = validateRequest({ body: RegisterRequestSchema });
const validateLogin = validateRequest({ body: LoginRequestSchema });
const validateRefresh = validateRequest({ body: RefreshRequestSchema });
const validateLogout = validateRequest({ body: LogoutRequestSchema });
const validateOAuthCallback = validateRequest({ query: OAuthCallbackRequestSchema });

export interface AuthDomain {
  register(req: unknown): Promise<unknown>;
  login(req: unknown): Promise<unknown>;
  refresh(req: unknown): Promise<unknown>;
  logout(req: unknown): Promise<void>;
  oauthCallback(req: unknown): Promise<unknown>;
}

export function createAuthRouter(domain: AuthDomain): Router {
  const router = Router();

  router.post("/register", validateRegister, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.register(req.validated?.body);
    res.status(201).json({ data: result });
  });

  router.post("/login", validateLogin, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.login(req.validated?.body);
    res.json({ data: result });
  });

  router.post("/refresh", validateRefresh, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.refresh(req.validated?.body);
    res.json({ data: result });
  });

  router.post("/logout", validateLogout, async (req: Request, res: Response): Promise<void> => {
    await domain.logout(req.validated?.body);
    res.status(204).end();
  });

  // OAuth callback — input in query params, not body
  router.get("/google/callback", validateOAuthCallback, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.oauthCallback(req.validated?.query);
    res.json({ data: result });
  });

  return router;
}
