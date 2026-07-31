/**
 * Security response headers middleware.
 *
 * Emits a full security header set on every gateway response:
 *   - Content-Security-Policy (explicit CSP; no unsafe-inline for scripts)
 *   - Strict-Transport-Security max-age=63072000; includeSubDomains (production/staging only)
 *   - X-Content-Type-Options: nosniff
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - X-Frame-Options: DENY (belt-and-suspenders alongside CSP frame-ancestors)
 *   - Permissions-Policy: locks camera, microphone, geolocation
 *
 * HSTS is intentionally suppressed on local development so http://localhost
 * is not pinned, which would break the local stack for up to two years.
 */

interface Response {
  setHeader(name: string, value: string): void;
}

interface NextFn {
  (): void;
}

/**
 * Detects whether HSTS should be emitted. Returns true for staging and
 * production; never true for local development or test environments.
 */
function isHstsEnvironment(): boolean {
  const env = process.env['NODE_ENV'] ?? '';
  return env === 'production' || env === 'staging';
}

/** Assembled once at module scope so header composition runs once. */
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self' https://api.stripe.com https://js.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HSTS_VALUE = 'max-age=63072000; includeSubDomains';

export interface SecurityHeadersOptions {
  /**
   * Override HSTS emission. When undefined the middleware reads NODE_ENV.
   * Pass `true` in staging/production integration tests that do not set
   * NODE_ENV to a recognised value.
   */
  emitHsts?: boolean;
}

/**
 * Returns an Express-compatible middleware that writes all security headers.
 * Mount first in the middleware stack so headers are present on every response
 * including error responses.
 */
export function createSecurityHeaders(opts?: SecurityHeadersOptions) {
  const emitHsts = opts?.emitHsts ?? isHstsEnvironment();

  return function securityHeaders(
    _req: unknown,
    res: Response,
    next: NextFn,
  ): void {
    res.setHeader('Content-Security-Policy', CSP_VALUE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (emitHsts) {
      res.setHeader('Strict-Transport-Security', HSTS_VALUE);
    }

    next();
  };
}
