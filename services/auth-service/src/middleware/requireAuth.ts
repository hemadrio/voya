/**
 * requireAuth — extracts and validates the actor context forwarded by the
 * api-gateway as the x-internal-actor header.
 *
 * The api-gateway sets this header after RS256 JWT verification (WO-017).
 * Auth-service routes that need an authenticated caller use this middleware
 * rather than verifying JWTs themselves.
 *
 * If the header is absent or malformed, the middleware returns 401
 * UNAUTHENTICATED without revealing why — this is defence in depth for the
 * (rare) case where a request reaches the auth-service without passing
 * through the gateway.
 */

import { unauthenticated } from "@travel/contracts";
import type { ActorContext } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Express-compatible inline types (no @types/express import at module level)
// ---------------------------------------------------------------------------

interface ActorRequest {
  headers: Record<string, string | string[] | undefined>;
  actor?: ActorContext;
}

interface MinimalResponse {
  status(code: number): this;
  json(body: unknown): this;
  headersSent: boolean;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function requireAuth(req: ActorRequest, res: MinimalResponse, next: NextFn): void {
  const raw = req.headers["x-internal-actor"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;

  if (typeof headerValue !== "string" || headerValue.length === 0) {
    next(unauthenticated());
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    next(unauthenticated());
    return;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["sub"] !== "string" ||
    typeof (parsed as Record<string, unknown>)["sid"] !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>)["roles"]) ||
    typeof (parsed as Record<string, unknown>)["jti"] !== "string"
  ) {
    next(unauthenticated());
    return;
  }

  const p = parsed as Record<string, unknown>;
  req.actor = {
    sub: p["sub"] as string,
    sid: p["sid"] as string,
    roles: p["roles"] as string[],
    jti: p["jti"] as string,
  };

  next();
}
