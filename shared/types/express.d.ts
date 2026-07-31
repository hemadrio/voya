/**
 * Global Express Request augmentation — adds properties set by shared middleware.
 *
 * Services include this file via their tsconfig `include` or `typeRoots`
 * settings once they have `@types/express` installed.
 *
 * WHY `req.validated` instead of overwriting `req.body`:
 *   The Stripe webhook route must keep `req.body` as a raw Buffer for HMAC
 *   signature verification.  Overwriting `req.body` on that path would
 *   silently break signature verification.  Using a separate `validated`
 *   namespace avoids the conflict.
 */

import type { ValidatedData } from "../middleware/validateRequest.js";

/** Minimal structured request logger — duck-typed against pino.Logger. */
interface RequestChildLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, string>): RequestChildLogger;
}

/** Actor context forwarded by the api-gateway as x-internal-actor. */
interface ActorContext {
  sub: string;
  sid: string;
  roles: string[];
  jti: string;
}

declare global {
  namespace Express {
    interface Request {
      /** Parsed and coerced inputs set by `validateRequest` on success. */
      validated?: ValidatedData;

      /**
       * Verified actor context — set by requireAuth middleware after parsing
       * the x-internal-actor header forwarded by the api-gateway.
       */
      actor?: ActorContext;

      /**
       * Resolved correlation identifier — set by correlationIdMiddleware.
       * Equal to the validated inbound x-correlation-id or a generated ULID.
       */
      correlationId?: string;

      /**
       * Request-scoped child logger — set by correlationIdMiddleware when a
       * root logger is injected.  Carries correlationId, traceId, method, and
       * route bindings so every log line for this request is correlated.
       */
      log?: RequestChildLogger;
    }
  }
}

export {};
