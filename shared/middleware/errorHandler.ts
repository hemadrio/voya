/**
 * Shared Express error middleware — thin adapter over @travel/contracts serialiseError.
 *
 * Usage (each service's Express app wiring — WO-007):
 * ```ts
 * import { createErrorHandler } from "../../shared/middleware/errorHandler.js";
 * app.use(createErrorHandler({ logger }));
 * ```
 *
 * The middleware:
 *  1. Reads the active trace / correlation identifier from the
 *     `X-Trace-Id` request header (injected by the gateway or ADOT sidecar).
 *  2. Delegates to `serialiseError` from @travel/contracts, which converts any
 *     thrown value — ZodError, DomainError, or unknown — into the documented
 *     error envelope and the correct HTTP status, with no internal detail leaking.
 *  3. Optionally logs the error via an injected logger (WO-007 wires this up).
 *  4. Writes `res.status(status).json(envelope)`.
 *
 * Constraints (from WO-002):
 *  - @travel/contracts must NOT import Express; all HTTP framework code stays here.
 *  - The wiring of this handler into individual service apps is delivered by WO-007.
 *
 * NOTE: This file is intentionally NOT part of a workspace package and carries
 * no package.json.  Services reference it via a relative import.  When the
 * shared package is formally scaffolded in a later WO, this file migrates into
 * that package without API changes.
 */

import { serialiseError } from "@travel/contracts";
import type { ErrorEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Minimal Express-compatible interface types.
//
// Typed inline rather than importing from `express` so this file can be
// compiled without an explicit `express` devDependency.  The shapes match
// Express 4/5 exactly; swap for `import type { Request, Response, NextFunction }
// from "express"` once the service package has @types/express installed.
// ---------------------------------------------------------------------------

interface Request {
  headers: Record<string, string | string[] | undefined>;
}

interface Response {
  status(code: number): this;
  json(body: ErrorEnvelope): this;
  headersSent: boolean;
}

type NextFunction = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Minimal logger interface — duck-typed so this file does not import
// @travel/observability directly.  A pino.Logger satisfies this interface.
// WO-007 wires the concrete logger in at service startup.
// ---------------------------------------------------------------------------

interface ErrorLogger {
  error(obj: { err: unknown; status: number; traceId: string | undefined }, msg: string): void;
}

export interface CreateErrorHandlerOptions {
  /**
   * Optional structured logger.  When supplied, every error is logged with
   * the serialised error object, HTTP status, and traceId before the response
   * is written.  Injected by service startup — never imported as a singleton.
   *
   * TODO(WO-007): inject @travel/observability createLogger here during
   * service scaffold so all errors are logged in structured JSON.
   */
  readonly logger?: ErrorLogger;
}

/**
 * Express four-argument error middleware factory.
 *
 * Returns a middleware function that converts any thrown value into the
 * standard error envelope and writes the appropriate HTTP status.
 *
 * The `_next` parameter is intentionally accepted-but-unused: Express
 * identifies an error handler by its four-argument arity.
 */
export function createErrorHandler(options?: CreateErrorHandlerOptions): (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => void {
  const logger = options?.logger;

  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
  ): void {
    // Guard: if headers have already been sent (e.g. a streaming response
    // partially flushed), we cannot write a new status/body — delegate.
    if (res.headersSent) {
      _next(err);
      return;
    }

    // The X-Trace-Id header is injected by the gateway or ADOT sidecar and
    // propagated on the internal mTLS hop.  Use it as the reference so the
    // traveler's error reference links directly to the X-Ray trace.
    const rawTraceId = req.headers["x-trace-id"];
    const traceId = Array.isArray(rawTraceId) ? rawTraceId[0] : rawTraceId;

    const { envelope, status } = serialiseError(err, traceId);

    // Structured error log — only when a logger is injected.  PII redaction
    // is handled by the @travel/observability logger, not here.
    logger?.error({ err, status, traceId }, "Unhandled error converted to error envelope");

    res.status(status).json(envelope);
  };
}
