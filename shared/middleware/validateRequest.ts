/**
 * validateRequest — schema-driven Express middleware factory.
 *
 * Usage:
 * ```ts
 * import { validateRequest } from "../../shared/middleware/validateRequest.js";
 * import { FlightSearchRequestSchema } from "@travel/contracts";
 *
 * router.post(
 *   "/search/flights",
 *   validateRequest({ body: FlightSearchRequestSchema }),
 *   flightSearchHandler,
 * );
 * ```
 *
 * On a parse failure the middleware responds immediately with HTTP 400 and
 * the WO-002 error envelope — `next()` is never called, so no business
 * logic, supplier adapter, or database call runs.
 *
 * On success the parsed (and coerced) values are attached to
 * `req.validated` so downstream handlers receive strongly typed input
 * without re-parsing.
 *
 * The factory closes over compiled Zod schemas at module scope, so parsing
 * cost is bounded to parse time only — schemas are never rebuilt per
 * request.
 *
 * Inline Express-compatible interface types are used (same pattern as
 * errorHandler.ts) so this file compiles without an explicit `express`
 * devDependency in the shared module.  Services that import this file
 * supply concrete Express types through `@types/express`.
 */

import type { ZodTypeAny } from "zod";
import { serialiseError } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The parsed values attached to the request on successful validation. */
export interface ValidatedData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: unknown;
}

/** Per-location Zod schema map — all fields are optional. */
export interface ValidationSchemas {
  /** Schema for `req.body`. */
  body?: ZodTypeAny;
  /** Schema for `req.query`. */
  query?: ZodTypeAny;
  /** Schema for `req.params`. */
  params?: ZodTypeAny;
  /** Schema for `req.headers`. */
  headers?: ZodTypeAny;
}

// ---------------------------------------------------------------------------
// Inline Express-compatible interface types (no @types/express import)
// ---------------------------------------------------------------------------

interface ValidatableRequest {
  body: unknown;
  query: unknown;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Populated by validateRequest on success — never defined by Express itself. */
  validated?: ValidatedData;
}

interface MinimalResponse {
  status(code: number): this;
  json(body: unknown): this;
  headersSent: boolean;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that validates the request against per-location
 * Zod schemas.
 *
 * Schemas are compiled once when the factory is called (module scope in route
 * files) — not per request — so parse cost stays within the 8 ms budget on
 * the ~180 ms p95 cache-hit search path.
 *
 * @param schemas  Object containing optional body/query/params/headers schemas.
 * @returns        Express `RequestHandler` (3-argument middleware).
 */
export function validateRequest(schemas: ValidationSchemas) {
  // Capture at factory call time, not per-request.
  const { body: bodySchema, query: querySchema, params: paramsSchema, headers: headersSchema } = schemas;

  return function requestValidator(
    req: ValidatableRequest,
    res: MinimalResponse,
    next: NextFn,
  ): void {
    if (res.headersSent) {
      next();
      return;
    }

    // Read the trace ID injected by the gateway (same convention as errorHandler).
    const rawTraceId = req.headers["x-trace-id"];
    const traceId = Array.isArray(rawTraceId) ? rawTraceId[0] : rawTraceId;

    // Validate each location in turn; cache parsed output to avoid double-parse.
    // Order: headers → params → query → body (fail-fast on first error).
    const locations: Array<{ key: keyof ValidatedData; schema: ZodTypeAny | undefined; value: unknown }> = [
      { key: "headers", schema: headersSchema, value: req.headers },
      { key: "params",  schema: paramsSchema,  value: req.params  },
      { key: "query",   schema: querySchema,   value: req.query   },
      { key: "body",    schema: bodySchema,    value: req.body    },
    ];

    const validated: ValidatedData = {};

    for (const { key, schema, value } of locations) {
      if (schema === undefined) continue;
      const result = schema.safeParse(value);
      if (!result.success) {
        const { envelope, status } = serialiseError(result.error, traceId);
        res.status(status).json(envelope);
        return;
      }
      // Store the coerced/transformed output — not the raw input.
      validated[key] = result.data as never;
    }

    req.validated = validated;
    next();
  };
}
