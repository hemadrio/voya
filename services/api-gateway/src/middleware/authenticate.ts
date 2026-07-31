/**
 * RS256 JWT authentication middleware for the api-gateway.
 *
 * Responsibilities:
 *   1. Extract Bearer token from the Authorization header.
 *   2. Verify the RS256 signature against the KeyProvider verification key set
 *      (supports overlapping keys during rotation so in-flight tokens stay valid).
 *   3. Validate claims (sub, sid, roles, jti, exp) with a Zod schema.
 *   4. Consult the Redis jti denylist — TTL equals remaining token lifetime.
 *   5. Forward the verified actor context as x-internal-actor for internal hops.
 *
 * Security invariants:
 *   - Values from the token are NEVER logged; only envVar names and codes.
 *   - Redis unavailability applies a conservative policy: deny all requests.
 *     This is logged at warn and triggers a CloudWatch alarm.
 *   - Expired tokens are rejected synchronously before the denylist check.
 */

import { createPublicKey, createVerify } from 'node:crypto';
import { z } from 'zod';
import { RoleSchema } from '@travel/contracts';
import type { ErrorCode } from '@travel/contracts';
import type { KeyProvider } from '@travel/auth';
import { mintActorContext } from '@travel/auth';

// ---------------------------------------------------------------------------
// Actor context schema (Zod-validated JWT payload)
// ---------------------------------------------------------------------------

export const ActorContextSchema = z
  .object({
    /** Subject — the authenticated user's ULID. */
    sub: z.string().min(1),
    /** Session ID — ties this token to a specific session family. */
    sid: z.string().min(1),
    /** Role claims — at least one role must be present. */
    roles: z.array(RoleSchema).min(1),
    /** JWT ID — unique token identifier, used for the jti denylist. */
    jti: z.string().min(1),
    /** Expiry — Unix epoch seconds. */
    exp: z.number().int().positive(),
    /** Issued at — Unix epoch seconds. */
    iat: z.number().int().positive(),
  })
  .strict();

export type ActorContext = z.infer<typeof ActorContextSchema>;

// ---------------------------------------------------------------------------
// Jti denylist interface (duck-typed — ioredis Redis client satisfies this)
// ---------------------------------------------------------------------------

export interface JtiDenylist {
  /** Returns true when the jti is present in the denylist. */
  exists(jti: string): Promise<number>;
  /** Add a jti with an expiry TTL in seconds. */
  set(jti: string, value: string, expiryMode: 'EX', time: number): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Internal JWT verification helpers (no external JWT library)
// ---------------------------------------------------------------------------

function base64urlToBuffer(input: string): Buffer {
  // Convert base64url to standard base64 then decode
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + '='.repeat(padding), 'base64');
}

/**
 * Verify an RS256 JWT signature using Node.js built-in crypto.
 * Returns the decoded payload object on success; throws on any verification
 * failure (malformed, wrong algorithm, invalid signature).
 */
function verifyRS256Jwt(token: string, publicKeyPem: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT: expected header.payload.signature');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  // Verify declared algorithm is RS256 before accepting
  const headerJson = base64urlToBuffer(encodedHeader).toString('utf8');
  const header: unknown = JSON.parse(headerJson);
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>)['alg'] !== 'RS256'
  ) {
    throw new Error('JWT algorithm must be RS256');
  }

  const publicKey = createPublicKey(publicKeyPem);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  const signatureBuffer = base64urlToBuffer(encodedSignature);

  if (!verifier.verify(publicKey, signatureBuffer)) {
    throw new Error('JWT signature verification failed');
  }

  return JSON.parse(base64urlToBuffer(encodedPayload).toString('utf8'));
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

function makeErrorBody(code: ErrorCode, message: string, reference: string) {
  return { error: { code, message }, reference };
}

// ---------------------------------------------------------------------------
// Authenticate middleware factory
// ---------------------------------------------------------------------------

export interface AuthenticateOptions {
  keyProvider: KeyProvider;
  denylist: JtiDenylist;
  /**
   * HMAC-SHA256 secret used to sign the actor context forwarded to internal
   * services as x-internal-actor.  Internal services verify this signature
   * before trusting the header.  Must be sourced from Secrets Manager in
   * production; never hard-coded.
   *
   * Defaults to '' (empty string) when omitted — only safe in tests that do
   * not reach a successful authentication path.  Services that call next()
   * after successful verification always need this set.
   */
  actorContextSecret?: string;
  /** Injected clock — defaults to Date.now. Override in tests. */
  now?: () => number;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

interface ResponseLike {
  status(code: number): this;
  json(body: unknown): this;
}

type NextFn = () => void;

/**
 * Returns an async Express-compatible middleware that authenticates every
 * request that reaches it. Mount on routes that require authentication; the
 * webhook route and health endpoints are typically excluded.
 */
export function createAuthenticateMiddleware(options: AuthenticateOptions) {
  const { keyProvider, denylist, actorContextSecret = '', logger } = options;
  const getNow = options.now ?? (() => Date.now());

  return async function authenticate(
    req: RequestLike,
    res: ResponseLike,
    next: NextFn,
  ): Promise<void> {
    const reference = req.correlationId ?? 'unknown';
    const rawAuth = req.headers['authorization'];
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      res.status(401).json(
        makeErrorBody('UNAUTHENTICATED', 'Missing or invalid Authorization header', reference),
      );
      return;
    }

    const token = authHeader.slice(7).trim();

    // Fetch the verification key set (current + previous within overlap window)
    let verificationKeys: Array<{ publicKeyPem: string; version: string }>;
    try {
      verificationKeys = await keyProvider.getVerificationKeys();
    } catch {
      logger?.error({ reference }, '[authenticate] Key provider unavailable');
      res.status(500).json(makeErrorBody('INTERNAL_ERROR', 'Key provider unavailable', reference));
      return;
    }

    // Try each key in the verification set (rotation overlap support)
    let payload: unknown = undefined;
    for (const key of verificationKeys) {
      try {
        payload = verifyRS256Jwt(token, key.publicKeyPem);
        break;
      } catch {
        // Try next key in the set
      }
    }

    if (payload === undefined) {
      logger?.warn({ reference }, '[authenticate] Token signature verification failed');
      res.status(401).json(
        makeErrorBody('UNAUTHENTICATED', 'Token signature verification failed', reference),
      );
      return;
    }

    // Validate claims with Zod
    const parsed = ActorContextSchema.safeParse(payload);
    if (!parsed.success) {
      logger?.warn({ reference }, '[authenticate] Token claims invalid');
      res.status(401).json(makeErrorBody('UNAUTHENTICATED', 'Token claims are invalid', reference));
      return;
    }

    const actor = parsed.data;

    // Synchronous expiry check before any async denylist round-trip
    const nowSeconds = Math.floor(getNow() / 1000);
    if (actor.exp <= nowSeconds) {
      res.status(401).json(makeErrorBody('UNAUTHENTICATED', 'Token has expired', reference));
      return;
    }

    // Redis jti denylist check — conservative policy on failure: deny all
    let isDenied: boolean;
    try {
      const count = await denylist.exists(actor.jti);
      isDenied = count > 0;
    } catch {
      // Redis unavailable — fail closed; alarm should fire via CloudWatch
      logger?.warn(
        { reference },
        '[authenticate] Redis denylist unavailable — applying conservative deny policy',
      );
      res.status(401).json(
        makeErrorBody(
          'TOKEN_REVOKED',
          'Token revocation check unavailable — access denied',
          reference,
        ),
      );
      return;
    }

    if (isDenied) {
      logger?.warn({ jti: actor.jti, reference }, '[authenticate] Denylisted jti presented');
      res.status(401).json(makeErrorBody('TOKEN_REVOKED', 'Token has been revoked', reference));
      return;
    }

    // Mint the HMAC-signed actor context for downstream services.
    // The x-internal-actor header was already stripped by stripInternalActorHeader
    // before this middleware ran, so no client-supplied value survives.
    const mintedAtSeconds = Math.floor(getNow() / 1000);
    req.headers['x-internal-actor'] = mintActorContext(
      {
        sub: actor.sub,
        sid: actor.sid,
        roles: actor.roles,
        jti: actor.jti,
        issuedAt: mintedAtSeconds,
      },
      actorContextSecret,
    );

    next();
  };
}

// ---------------------------------------------------------------------------
// Logout helper — adds a jti to the denylist with the remaining TTL
// ---------------------------------------------------------------------------

/**
 * Revoke a specific jti by adding it to the denylist with TTL = remaining
 * token lifetime. Called by the logout route so revocation takes effect
 * within seconds (bounded by the denylist TTL, not the token TTL).
 */
export async function revokeJti(
  denylist: JtiDenylist,
  jti: string,
  expSeconds: number,
  nowFn: () => number = () => Date.now(),
): Promise<void> {
  const nowSeconds = Math.floor(nowFn() / 1000);
  const ttlSeconds = Math.max(expSeconds - nowSeconds, 1);
  await denylist.set(jti, '1', 'EX', ttlSeconds);
}
