/**
 * Shared Express error middleware — thin adapter over @travel/contracts serialiseError.
 *
 * Usage (each service's Express app wiring):
 * ```ts
 * import { createErrorHandler } from "../../shared/middleware/errorHandler.js";
 * app.use(createErrorHandler({ logger }));
 * ```
 *
 * The middleware:
 *  1. Resolves the active correlation / trace identifier from req.correlationId
 *     (set by correlationIdMiddleware), falling back to the x-correlation-id
 *     and x-trace-id request headers.
 *  2. Delegates to `serialiseError` from @travel/contracts to produce the
 *     standard envelope and HTTP status with no internal detail leaking.
 *  3. Logs at warn level for 4xx and error level for 5xx via the injected
 *     logger; logs nothing when no logger is supplied.
 *  4. Writes `res.status(status).json(envelope)`.
 *
 * Constraints:
 *  - @travel/contracts must NOT import Express; all HTTP framework code stays here.
 *  - Never call next() after responding — the error is terminal.
 *  - If headers are already sent (partial stream), delegate to next(err).
 */

import { serialiseError } from "@travel/contracts";
import type { ErrorEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Minimal Express-compatible interface types (inline — no express import).
// ---------------------------------------------------------------------------

interface Request {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string | undefined;
}

interface Response {
  status(code: number): this;
  json(body: ErrorEnvelope): this;
  headersSent: boolean;
}

type NextFunction = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Minimal logger interface — duck-typed for warn/error levels.
// A pino.Logger satisfies this interface.
// ---------------------------------------------------------------------------

interface ErrorLogger {
  warn(obj: { err: unknown; status: number; correlationId: string | undefined }, msg: string): void;
  error(obj: { err: unknown; status: number; correlationId: string | undefined }, msg: string): void;
}

export interface CreateErrorHandlerOptions {
  /**
   * Optional structured logger (e.g. from @travel/observability createLogger).
   * When supplied, 4xx errors are logged at warn and 5xx at error, each with
   * the serialised error object, HTTP status, and correlation identifier.
   */
  readonly logger?: ErrorLogger | undefined;
}

/**
 * Express four-argument error middleware factory.
 *
 * Returns a middleware that converts any thrown value into the standard error
 * envelope and writes the appropriate HTTP status.  Logs at the correct level
 * (warn for 4xx, error for 5xx) when a logger is provided.
 *
 * The `_next` parameter is intentionally accepted-but-unused: Express
 * identifies an error handler by its four-argument arity.
 */
export function createErrorHandler(
  options?: CreateErrorHandlerOptions,
): (err: unknown, req: Request, res: Response, _next: NextFunction) => void {
  const logger = options?.logger;

  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    // Guard: if headers have already been sent (e.g. a streaming response
    // partially flushed), we cannot write a new status/body — delegate.
    if (res.headersSent) {
      _next(err);
      return;
    }

    // Resolve the trace/correlation reference.
    // Priority: req.correlationId (set by correlationIdMiddleware)
    //         > x-correlation-id header
    //         > x-trace-id header (legacy gateway header)
    const correlationId: string | undefined =
      typeof req.correlationId === 'string'
        ? req.correlationId
        : (() => {
            const cid = req.headers['x-correlation-id'];
            const candidate = Array.isArray(cid) ? cid[0] : cid;
            if (typeof candidate === 'string') return candidate;
            const tid = req.headers['x-trace-id'];
            const tCandidate = Array.isArray(tid) ? tid[0] : tid;
            return typeof tCandidate === 'string' ? tCandidate : undefined;
          })();

    const { envelope, status } = serialiseError(err, correlationId);

    // Log at appropriate level: warn for 4xx (client errors), error for 5xx
    if (logger !== undefined) {
      const logCtx = { err, status, correlationId };
      const msg = 'Unhandled error converted to error envelope';
      if (status >= 500) {
        logger.error(logCtx, msg);
      } else {
        logger.warn(logCtx, msg);
      }
    }

    res.status(status).json(envelope);
  };
}
