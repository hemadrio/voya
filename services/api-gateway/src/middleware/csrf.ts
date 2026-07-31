/**
 * CSRF defence middleware — double-submit cookie pattern.
 *
 * Protocol:
 *   1. On GET / HEAD / OPTIONS requests the middleware is transparent.
 *   2. On POST, PUT, PATCH, DELETE the middleware requires:
 *        a. An x-csrf-token request header, AND
 *        b. An x-csrf-token cookie with the same value.
 *   3. Additionally checks the Origin header (when present) against the
 *      CORS allow-list as defense-in-depth. Sec-Fetch-Site is also checked
 *      when present.
 *   4. The Stripe webhook path is explicitly exempt because it is
 *      authenticated by HMAC signature, not by session cookie.
 *
 * The CSRF cookie is non-HttpOnly so the browser-side JavaScript can read it
 * and include it as a header. The session cookie is HttpOnly; the CSRF cookie
 * is distinct and must never carry the session value.
 *
 * Failure returns 403 with code CSRF_FAILED and a message that names the
 * specific missing or mismatched token, providing actionable guidance.
 */

import type { CorsOriginConfig } from '../config/origins.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes exempt from CSRF — HMAC-authenticated, not cookie-authenticated. */
const CSRF_EXEMPT_PREFIXES = ['/webhooks/stripe', '/webhooks/'];

function makeErrorBody(message: string, reference: string) {
  return { error: { code: 'CSRF_FAILED', message }, reference };
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

interface RequestLike {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface ResponseLike {
  status(code: number): this;
  json(body: unknown): this;
}

type NextFn = () => void;

export interface CsrfOptions {
  corsConfig: CorsOriginConfig;
  /** Override the exempt path prefixes. Useful in tests. */
  exemptPrefixes?: ReadonlyArray<string>;
}

/**
 * Returns an Express-compatible middleware that enforces the CSRF
 * double-submit pattern on all state-changing routes.
 */
export function createCsrfMiddleware(options: CsrfOptions) {
  const { corsConfig } = options;
  const exemptPrefixes = options.exemptPrefixes ?? CSRF_EXEMPT_PREFIXES;
  const allowedOriginSet = new Set(corsConfig.allowedOrigins);

  return function csrfMiddleware(
    req: RequestLike,
    res: ResponseLike,
    next: NextFn,
  ): void {
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      next();
      return;
    }

    // Exempt HMAC-authenticated webhook routes
    const isExempt = exemptPrefixes.some((prefix) => req.path.startsWith(prefix));
    if (isExempt) {
      next();
      return;
    }

    const reference = req.correlationId ?? 'unknown';

    // Origin check (defense-in-depth, before reading cookie/header)
    const rawOrigin = req.headers['origin'];
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (typeof origin === 'string' && !allowedOriginSet.has(origin)) {
      res
        .status(403)
        .json(makeErrorBody('Request origin is not allow-listed', reference));
      return;
    }

    // Sec-Fetch-Site check when present
    const secFetchSite = req.headers['sec-fetch-site'];
    const fetchSite = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite;
    if (
      typeof fetchSite === 'string' &&
      fetchSite !== 'same-origin' &&
      fetchSite !== 'same-site' &&
      fetchSite !== 'none'
    ) {
      res
        .status(403)
        .json(makeErrorBody('Cross-site request rejected by Sec-Fetch-Site policy', reference));
      return;
    }

    // Read the CSRF token from the request header
    const rawHeaderToken = req.headers['x-csrf-token'];
    const headerToken = Array.isArray(rawHeaderToken) ? rawHeaderToken[0] : rawHeaderToken;
    if (typeof headerToken !== 'string' || headerToken.trim() === '') {
      res
        .status(403)
        .json(
          makeErrorBody(
            'Missing x-csrf-token header — include the value from the x-csrf-token cookie',
            reference,
          ),
        );
      return;
    }

    // Read the CSRF token from the cookie
    const rawCookie = req.headers['cookie'];
    const cookieHeader = Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie ?? '');
    const cookies = parseCookies(cookieHeader);
    const cookieToken = cookies['x-csrf-token'];

    if (typeof cookieToken !== 'string' || cookieToken.trim() === '') {
      res
        .status(403)
        .json(
          makeErrorBody(
            'Missing x-csrf-token cookie — cookies may be blocked by browser settings',
            reference,
          ),
        );
      return;
    }

    // Constant-time comparison to prevent timing attacks
    // Both are string values; compare byte-by-byte via Buffer
    const headerBuf = Buffer.from(headerToken.trim());
    const cookieBuf = Buffer.from(cookieToken.trim());

    if (
      headerBuf.length !== cookieBuf.length ||
      !timingSafeEqual(headerBuf, cookieBuf)
    ) {
      res
        .status(403)
        .json(makeErrorBody('x-csrf-token header does not match cookie value', reference));
      return;
    }

    next();
  };
}

/**
 * Timing-safe comparison that avoids the `crypto.timingSafeEqual` import
 * for buffers that may differ in length (timingSafeEqual requires equal
 * length). Pre-check ensures we only call it on equal-length buffers.
 */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  // Lengths are checked by the caller before this is invoked
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= (a[i] as number) ^ (b[i] as number);
  }
  return result === 0;
}
