/**
 * TokenService — RS256/HS256 JWT signing and verification.
 *
 * Security invariants:
 *   - Algorithm allow-list: only RS256 and HS256 are accepted; "none" is
 *     explicitly forbidden at both sign-time (config check) and verify-time.
 *   - Algorithm is NEVER inferred from the token header; config.algorithm is
 *     always used. The header.alg is checked only to prevent algorithm-
 *     confusion substitution attacks.
 *   - Signing keys must come from configuration or a secret manager and must
 *     never be committed to the repository.
 *   - kid is embedded in every JWT header to support rotation overlap.
 *
 * Rotation model:
 *   - config.signingKey  → the currently active private (RS256) or shared (HS256) key.
 *   - config.verificationKeys → full set of still-trusted public (RS256) or shared
 *     (HS256) keys, keyed by kid.  During rotation add the new entry here while
 *     keeping the old one until all outstanding tokens have expired.
 *
 * Implementation uses only Node.js built-in crypto — no external JWT library.
 */

import {
  createSign,
  createVerify,
  createHmac,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from 'node:crypto';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Buffer): string {
  return data
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlEncodeStr(str: string): string {
  return base64urlEncode(Buffer.from(str, 'utf8'));
}

function base64urlDecode(str: string): Buffer {
  // Re-pad to 4-char alignment, then reverse base64url → base64.
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Supported signing algorithms. "none" is not in this union intentionally. */
export type SupportedAlgorithm = 'RS256' | 'HS256';

/** Input payload used to mint an access token. */
export interface TokenPayload {
  /** User ID (becomes the `sub` claim). */
  sub: string;
  /** Session ID (becomes the `sid` claim). */
  sid: string;
  /** Role names to embed in the token. */
  roles: string[];
  /**
   * Optional pre-generated JWT ID.
   * When provided, this value is used as the `jti` claim instead of a randomly
   * generated one.  Use when the caller needs the jti before signing (e.g. to
   * store it in a session row for future revocation checks).
   */
  jti?: string;
}

/** Verified JWT claims returned by verify(). */
export interface TokenClaims {
  sub: string;
  sid: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  roles: string[];
}

/** A single key entry in the signing/verification registry. */
export interface KeyEntry {
  /** Key identifier embedded in the JWT header. */
  kid: string;
  /**
   * RS256: PEM-encoded private key (sign) or public key (verify).
   * HS256: shared secret string.
   */
  key: string;
}

export interface TokenConfig {
  /** Must be RS256 or HS256 — "none" is rejected at construction time. */
  algorithm: SupportedAlgorithm;
  /** Currently active signing key. */
  signingKey: KeyEntry;
  /**
   * Full set of verification keys, including the current key plus any recently
   * rotated-out keys whose issued tokens may still be within their TTL.
   * Must contain at least one entry matching signingKey.kid for self-verification.
   */
  verificationKeys: KeyEntry[];
  /** `iss` claim — typically the service URL, e.g. "https://auth.example.com". */
  issuer: string;
  /** `aud` claim — typically the API base URL or service name. */
  audience: string;
  /** Access-token lifetime in seconds (recommended 600–900 s). */
  accessTokenTtlSeconds: number;
  /**
   * Allowed clock drift when comparing iat/exp to the current time.
   * Defaults to 30 seconds.
   */
  clockSkewSeconds?: number;
}

export interface ITokenService {
  /** Mint a signed JWT access token. Returns the compact serialisation. */
  sign(payload: TokenPayload): string;
  /** Verify and parse a JWT access token.  Throws on any failure. */
  verify(token: string): TokenClaims;
}

// ---------------------------------------------------------------------------
// Algorithm allow-list
// ---------------------------------------------------------------------------

const ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set<SupportedAlgorithm>(['RS256', 'HS256']);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTokenService(config: TokenConfig): ITokenService {
  const { algorithm, signingKey, issuer, audience, accessTokenTtlSeconds } = config;
  const clockSkewSeconds = config.clockSkewSeconds ?? 30;

  // Reject disallowed algorithms at construction time.
  if (!ALLOWED_ALGORITHMS.has(algorithm)) {
    throw new Error(
      `TokenService: algorithm "${algorithm}" is not in the allow-list [RS256, HS256]. ` +
        'The "none" algorithm and any unrecognised algorithm are forbidden.',
    );
  }

  // Build an O(1) lookup map: kid → raw key material.
  const verificationKeyMap = new Map<string, string>(
    config.verificationKeys.map((k) => [k.kid, k.key]),
  );

  // ── sign ──────────────────────────────────────────────────────────────────

  function sign(payload: TokenPayload): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const jti = payload.jti ?? randomBytes(16).toString('hex');

    const header = { alg: algorithm, typ: 'JWT', kid: signingKey.kid };
    const claims: TokenClaims = {
      sub: payload.sub,
      sid: payload.sid,
      iss: issuer,
      aud: audience,
      iat: nowSec,
      exp: nowSec + accessTokenTtlSeconds,
      jti,
      roles: payload.roles,
    };

    const encodedHeader = base64urlEncodeStr(JSON.stringify(header));
    const encodedPayload = base64urlEncodeStr(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    let signatureBuffer: Buffer;

    if (algorithm === 'RS256') {
      const privateKey = createPrivateKey(signingKey.key);
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signatureBuffer = signer.sign(privateKey);
    } else {
      // HS256
      const hmac = createHmac('sha256', signingKey.key);
      hmac.update(signingInput);
      signatureBuffer = hmac.digest();
    }

    return `${signingInput}.${base64urlEncode(signatureBuffer)}`;
  }

  // ── verify ────────────────────────────────────────────────────────────────

  function verify(token: string): TokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('TokenService: malformed JWT — expected exactly 3 dot-separated parts');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    // --- Parse header ---
    let rawHeader: unknown;
    try {
      rawHeader = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'));
    } catch {
      throw new Error('TokenService: failed to parse JWT header');
    }
    if (typeof rawHeader !== 'object' || rawHeader === null) {
      throw new Error('TokenService: JWT header is not a JSON object');
    }

    const headerObj = rawHeader as Record<string, unknown>;
    const headerAlg = headerObj['alg'];
    const headerKid = headerObj['kid'];

    // SECURITY: Never infer algorithm from token header. Use config.algorithm.
    // Check that header.alg matches config to prevent algorithm confusion attacks.
    if (headerAlg !== algorithm) {
      throw new Error(
        `TokenService: JWT algorithm mismatch — config expects "${algorithm}", token header has "${String(headerAlg)}"`,
      );
    }

    // Belt-and-suspenders: reject "none" regardless of config (should be impossible
    // given the allow-list at construction, but explicit rejection is critical).
    if (headerAlg === 'none' || algorithm === 'none') {
      throw new Error('TokenService: the "none" algorithm is not accepted');
    }

    // --- Key lookup ---
    const kid = typeof headerKid === 'string' ? headerKid : '';
    const rawVerificationKey = verificationKeyMap.get(kid);
    if (!rawVerificationKey) {
      throw new Error(`TokenService: no verification key found for kid "${kid}"`);
    }

    // --- Signature verification (using config.algorithm, NOT header.alg) ---
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signatureBuffer = base64urlDecode(encodedSignature);
    let valid: boolean;

    if (algorithm === 'RS256') {
      const publicKey = createPublicKey(rawVerificationKey);
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingInput);
      valid = verifier.verify(publicKey, signatureBuffer);
    } else {
      // HS256
      const hmac = createHmac('sha256', rawVerificationKey);
      hmac.update(signingInput);
      const expected = hmac.digest();
      valid =
        expected.length === signatureBuffer.length &&
        timingSafeEqual(expected, signatureBuffer);
    }

    if (!valid) {
      throw new Error('TokenService: JWT signature verification failed');
    }

    // --- Parse payload ---
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'));
    } catch {
      throw new Error('TokenService: failed to parse JWT payload');
    }
    if (typeof rawPayload !== 'object' || rawPayload === null) {
      throw new Error('TokenService: JWT payload is not a JSON object');
    }

    const c = rawPayload as Record<string, unknown>;
    const nowSec = Math.floor(Date.now() / 1000);

    // --- Claim validation ---
    if (typeof c['exp'] !== 'number') {
      throw new Error('TokenService: JWT missing "exp" claim');
    }
    if (c['exp'] < nowSec - clockSkewSeconds) {
      throw new Error('TokenService: JWT has expired');
    }

    if (typeof c['iat'] !== 'number') {
      throw new Error('TokenService: JWT missing "iat" claim');
    }
    if (c['iat'] > nowSec + clockSkewSeconds) {
      throw new Error('TokenService: JWT "iat" is in the future');
    }

    if (c['iss'] !== issuer) {
      throw new Error(`TokenService: JWT issuer mismatch — expected "${issuer}", got "${String(c['iss'])}"`);
    }

    if (c['aud'] !== audience) {
      throw new Error(`TokenService: JWT audience mismatch — expected "${audience}", got "${String(c['aud'])}"`);
    }

    if (typeof c['sub'] !== 'string' || c['sub'] === '') {
      throw new Error('TokenService: JWT missing or empty "sub" claim');
    }
    if (typeof c['sid'] !== 'string' || c['sid'] === '') {
      throw new Error('TokenService: JWT missing or empty "sid" claim');
    }
    if (typeof c['jti'] !== 'string' || c['jti'] === '') {
      throw new Error('TokenService: JWT missing or empty "jti" claim');
    }

    return {
      sub: c['sub'] as string,
      sid: c['sid'] as string,
      iss: c['iss'] as string,
      aud: c['aud'] as string,
      iat: c['iat'] as number,
      exp: c['exp'] as number,
      jti: c['jti'] as string,
      roles: Array.isArray(c['roles']) ? (c['roles'] as string[]) : [],
    };
  }

  return { sign, verify };
}
