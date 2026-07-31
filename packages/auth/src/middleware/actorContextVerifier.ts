/**
 * Actor context minting and verification.
 *
 * The api-gateway calls mintActorContext() after JWT verification to produce a
 * signed x-internal-actor header.  Internal services call
 * createActorContextMiddleware() to parse and verify that header before
 * trusting its claims.
 *
 * Format: base64url(canonicalJson) + "." + base64url(hmac-sha256)
 *
 * Security invariants:
 *   - Clients can never forge the header: the gateway strips any inbound copy
 *     before the authenticate middleware runs (stripInternalActorHeader).
 *   - Services reject any header with a missing or invalid HMAC with 401 +
 *     error code ACTOR_CONTEXT_INVALID.
 *   - timingSafeEqual prevents timing-oracle attacks on HMAC comparison.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types (inline — avoids @types/express import in the shared package)
// ---------------------------------------------------------------------------

export interface ActorContextPayload {
  sub: string;
  sid: string;
  roles: string[];
  jti: string;
  issuedAt: number;
}

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  actor?: ActorContextPayload;
}

interface ResponseLike {
  status(code: number): this;
  json(body: unknown): this;
}

type NextFn = (err?: unknown) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function sortedJsonStringify(obj: unknown): string {
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(sortedJsonStringify).join(',')}]`;
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .map(k => `${JSON.stringify(k)}:${sortedJsonStringify((obj as Record<string, unknown>)[k])}`);
  return `{${sorted.join(',')}}`;
}

function validatePayload(raw: unknown): ActorContextPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p['sub'] !== 'string' || p['sub'].length === 0 ||
    typeof p['sid'] !== 'string' || p['sid'].length === 0 ||
    !Array.isArray(p['roles']) || (p['roles'] as unknown[]).length === 0 ||
    typeof p['jti'] !== 'string' || p['jti'].length === 0 ||
    typeof p['issuedAt'] !== 'number'
  ) {
    return null;
  }
  return {
    sub: p['sub'] as string,
    sid: p['sid'] as string,
    roles: p['roles'] as string[],
    jti: p['jti'] as string,
    issuedAt: p['issuedAt'] as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign an actor context payload. Called by the api-gateway after JWT
 * verification. Returns the signed header value to set as x-internal-actor.
 */
export function mintActorContext(payload: ActorContextPayload, secret: string): string {
  const canonical = sortedJsonStringify(payload);
  const encodedPayload = b64urlEncode(canonical);
  const hmac = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest();
  return `${encodedPayload}.${b64urlEncode(hmac)}`;
}

export type VerifyActorContextResult =
  | { ok: true; context: ActorContextPayload }
  | { ok: false; reason: string };

/**
 * Verify a signed actor context header value. Called by internal services.
 * Returns the parsed payload on success, or a failure reason on error.
 */
export function verifyActorContext(
  headerValue: string,
  secret: string,
): VerifyActorContextResult {
  const dotIdx = headerValue.lastIndexOf('.');
  if (dotIdx === -1) return { ok: false, reason: 'missing signature separator' };

  const encodedPayload = headerValue.slice(0, dotIdx);
  const encodedSig = headerValue.slice(dotIdx + 1);

  const expectedHmac = createHmac('sha256', secret)
    .update(encodedPayload)
    .digest();

  let providedHmac: Buffer;
  try {
    providedHmac = b64urlDecode(encodedSig);
  } catch {
    return { ok: false, reason: 'invalid base64url signature' };
  }

  if (
    expectedHmac.length !== providedHmac.length ||
    !timingSafeEqual(expectedHmac, providedHmac)
  ) {
    return { ok: false, reason: 'signature mismatch' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecode(encodedPayload).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed payload JSON' };
  }

  const payload = validatePayload(raw);
  if (payload === null) {
    return { ok: false, reason: 'invalid payload claims' };
  }

  return { ok: true, context: payload };
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

export interface ActorContextMiddlewareOptions {
  /** HMAC-SHA256 secret — must match the secret used by the gateway. */
  secret: string;
  /** Optional header name override. Defaults to 'x-internal-actor'. */
  headerName?: string;
}

/**
 * Returns an Express-compatible middleware that parses and signature-verifies
 * the x-internal-actor header. Sets req.actor on success; returns 401 with
 * ACTOR_CONTEXT_INVALID on failure.
 *
 * Apply globally on all internal services (before route handlers).
 */
export function createActorContextMiddleware(options: ActorContextMiddlewareOptions) {
  const { secret, headerName = 'x-internal-actor' } = options;

  return function actorContextMiddleware(
    req: RequestLike,
    res: ResponseLike,
    next: NextFn,
  ): void {
    const raw = req.headers[headerName];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;

    if (typeof headerValue !== 'string' || headerValue.length === 0) {
      res.status(401).json({
        error: { code: 'ACTOR_CONTEXT_INVALID', message: 'Actor context header is missing' },
      });
      return;
    }

    const result = verifyActorContext(headerValue, secret);
    if (!result.ok) {
      res.status(401).json({
        error: { code: 'ACTOR_CONTEXT_INVALID', message: 'Actor context header is invalid' },
      });
      return;
    }

    req.actor = result.context;
    next();
  };
}
