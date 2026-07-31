/**
 * RefreshService — opaque refresh token rotation with reuse detection.
 *
 * Algorithm:
 *   1. Hash the presented token with SHA-256.
 *   2. Look up the session by hash (returns any row — active or revoked).
 *   3. If no row → INVALID_REFRESH_TOKEN (generic 401).
 *   4. If row.revokedAt is set → theft signal: revoke whole family → REFRESH_TOKEN_REUSED (401).
 *   5. Check absolute lifetime → SESSION_EXPIRED (401).
 *   6. Check idle timeout (expiresAt) → SESSION_EXPIRED (401).
 *   7. Atomically revoke old session + create new session (rotate).
 *      If rotate returns null → concurrent race lost → INVALID_REFRESH_TOKEN (401, no family revoke).
 *   8. Mint new access token.
 *   9. Return new tokens.
 *
 * Security constraints (verbatim from WO-022):
 *   - Absolute session lifetime must never be extended by rotation.
 *   - Raw refresh tokens must never be logged, returned in error bodies, or stored unhashed.
 *   - Reuse detection triggers family-wide revocation, not just single-session revocation.
 */

import { randomBytes, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  invalidRefreshToken,
  refreshTokenReused,
  sessionExpired,
} from "@travel/contracts";
import type { SessionRepository, RotatedSessionRow } from "./SessionRepository.js";
import type { ITokenService, TokenPayload } from "./TokenService.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RefreshInput {
  /** Raw refresh token from cookie or body — will be hashed, never stored. */
  rawToken: string;
  /** Idle TTL for the new session row (milliseconds). Default: 14 days. */
  idleTtlMs?: number;
  /** Client IPv4/v6 for the new session row. */
  ipAddress?: string;
  /** User-Agent for the new session row. */
  userAgent?: string;
}

export interface RefreshOutput {
  /** New short-lived access token. */
  accessToken: string;
  tokenType: "Bearer";
  /** Access token lifetime in seconds. */
  expiresIn: number;
  /** New opaque refresh token (raw, base64url) — must be delivered via cookie. */
  newRefreshToken: string;
  /** Session info for setting the refresh cookie Max-Age. */
  refreshTtlMs: number;
  /** User ID from the rotated session. */
  userId: string;
}

export interface SecurityEventLogger {
  logReuseDetected(event: {
    userId: string;
    familyId: string | null;
    ipAddress: string | undefined;
    userAgent: string | undefined;
  }): Promise<void> | void;
}

export interface RefreshServiceDeps {
  sessionRepository: SessionRepository;
  tokenService: ITokenService;
  /** Access-token TTL in seconds. */
  accessTokenTtlSeconds: number;
  /** Refresh-token idle TTL in milliseconds. Default: 14 days. */
  idleTtlMs?: number;
  /** Optional security event logger for reuse detection events. */
  securityLogger?: SecurityEventLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically-secure base64url refresh token (32 bytes entropy). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hash of a raw refresh token for storage/lookup. */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface IRefreshService {
  refresh(input: RefreshInput): Promise<RefreshOutput>;
}

export function createRefreshService(deps: RefreshServiceDeps): IRefreshService {
  const {
    sessionRepository,
    tokenService,
    accessTokenTtlSeconds,
    idleTtlMs: defaultIdleTtlMs = 14 * 24 * 60 * 60 * 1000,
    securityLogger,
  } = deps;

  async function refresh(input: RefreshInput): Promise<RefreshOutput> {
    const hash = hashRefreshToken(input.rawToken);

    // Step 2: Look up by hash (any row — active or already revoked).
    const session = await sessionRepository.findByRefreshHash(hash);

    // Step 3: Unknown token → generic 401 (do NOT distinguish "never existed" from "wrong hash").
    if (!session) {
      throw invalidRefreshToken();
    }

    // Step 4: Row exists but is already revoked → theft signal.
    if (session.revokedAt !== null) {
      if (session.familyId) {
        await sessionRepository.revokeFamily(session.familyId);
      }
      // Log the security event (fire-and-forget acceptable for logging; the 401 is what matters).
      if (securityLogger) {
        try {
          await securityLogger.logReuseDetected({
            userId: session.userId,
            familyId: session.familyId,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
          });
        } catch {
          // Non-fatal: security log failure must not prevent the 401 from being returned.
        }
      }
      throw refreshTokenReused();
    }

    const now = new Date();

    // Step 5: Absolute lifetime check — enforced strictly (never extended by rotation).
    if (session.absoluteExpiresAt !== null && session.absoluteExpiresAt <= now) {
      throw sessionExpired("Your session has reached its absolute lifetime. Please log in again.");
    }

    // Step 6: Idle timeout check.
    if (session.expiresAt <= now) {
      throw sessionExpired("Your session has expired due to inactivity. Please log in again.");
    }

    // Step 7: Generate new tokens and rotate atomically.
    const newRawToken = generateRefreshToken();
    const newRefreshHash = hashRefreshToken(newRawToken);
    const newJti = randomUUID();
    const idleTtlMs = input.idleTtlMs ?? defaultIdleTtlMs;
    const newExpiresAt = new Date(now.getTime() + idleTtlMs);

    let rotated: RotatedSessionRow | null;
    try {
      rotated = await sessionRepository.rotate({
        oldSessionId: session.id,
        newToken: newJti,
        newRefreshTokenHash: newRefreshHash,
        newExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        familyId: session.familyId,
        userId: session.userId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch {
      // Unexpected DB error during rotation — surface as generic 401, not 500,
      // to avoid leaking internal state.
      throw invalidRefreshToken();
    }

    // Concurrent race lost (rotate returned null = P2025 on revokedAt IS NULL).
    // This is NOT reuse — the session was not revoked before our lookup; another
    // concurrent request just won the race. No family revocation.
    if (!rotated) {
      throw invalidRefreshToken();
    }

    // Step 8: Mint new access token.
    const tokenPayload: TokenPayload = {
      sub: rotated.userId,
      sid: rotated.newSessionId,
      jti: newJti,
      roles: ["user"],
    };
    const accessToken = tokenService.sign(tokenPayload);

    const refreshTtlMs = idleTtlMs;

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: accessTokenTtlSeconds,
      newRefreshToken: newRawToken,
      refreshTtlMs,
      userId: rotated.userId,
    };
  }

  return { refresh };
}
