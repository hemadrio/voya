/**
 * Strict CORS middleware for the api-gateway.
 *
 * Design rules:
 *   - Origin allow-list is configuration-driven per environment (not a single
 *     env var), so staging and production cannot inadvertently share dev origins.
 *   - Only the matched origin is echoed; a denied origin receives no
 *     Access-Control-Allow-Origin and is never echoed back.
 *   - Credentials (cookies) are enabled only for allow-listed origins.
 *   - Vary: Origin is always set so CDN caches do not serve a cached
 *     wrong-origin response.
 *   - Preflight (OPTIONS) requests from a denied origin return 204 with no
 *     Access-Control-* headers and are logged for SIEM visibility.
 */

import type { CorsOriginConfig } from '../config/origins.js';

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS =
  'Content-Type, Authorization, X-CSRF-Token, X-Correlation-ID, X-Requested-With';
const EXPOSED_HEADERS = 'X-Correlation-ID';
/** Preflight result cached for 2 hours on the client. */
const MAX_AGE = '7200';

interface RequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): this;
  end(): void;
}

type NextFn = () => void;

export interface CorsLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CorsMiddlewareOptions {
  config: CorsOriginConfig;
  logger?: CorsLogger;
}

/**
 * Returns an Express-compatible CORS middleware.
 *
 * Mount before any route handler so preflight responses are handled without
 * reaching authentication or business logic.
 */
export function createCorsMiddleware(options: CorsMiddlewareOptions) {
  const { config, logger } = options;
  const originSet = new Set(config.allowedOrigins);

  return function corsMiddleware(
    req: RequestLike,
    res: ResponseLike,
    next: NextFn,
  ): void {
    // Always set Vary: Origin — prevents CDN from serving one origin's response
    // to a different origin.
    res.setHeader('Vary', 'Origin');

    const rawOrigin = req.headers['origin'];
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;

    if (typeof origin === 'string' && originSet.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', MAX_AGE);
        res.status(204).end();
        return;
      }

      res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    } else if (typeof origin === 'string') {
      // Non-allow-listed origin: no Access-Control-Allow-Origin header.
      // Log for SIEM visibility so denied attempts surface in CloudWatch.
      logger?.warn(
        { origin, method: req.method },
        '[cors] Denied request from non-allow-listed origin',
      );
    }

    next();
  };
}
