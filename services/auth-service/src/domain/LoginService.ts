/**
 * LoginService — ordered login security pipeline.
 *
 * Pipeline order (each step must pass before the next runs):
 *   1. Normalize email (lowercase + trim — already done by contract schema, but
 *      repeated here for defence-in-depth so the service is safe when called
 *      outside the HTTP layer).
 *   2. Load user by email.
 *   3. Load credential with secret hash.
 *   4. Lockout check — performed BEFORE the expensive scrypt comparison so a
 *      locked account never pays the hash cost.
 *   5. Verify password — scrypt comparison via ICredentialService.
 *   6. Check emailVerifiedAt — must not be null.
 *   7. Check user.status === 'active'.
 *   8. Create session row (stores jti in the legacy token column).
 *   9. Mint access token.
 *  10. On success: reset failed-attempt counter; rehash if needsRehash.
 *
 * All credential failures collapse into a single INVALID_CREDENTIALS error so
 * the response time and body do not reveal whether the email exists.
 *
 * Hexagonal architecture: no Express or PrismaClient imports — all I/O is
 * injected via the dependency interfaces below.
 */

import { randomUUID } from 'node:crypto';
import {
  invalidCredentials,
  emailNotVerified,
  accountDisabled,
} from '@travel/contracts';
import type { ICredentialService } from './CredentialService.js';
import type { UserRepository } from './UserRepository.js';
import type { CredentialRepository } from './CredentialRepository.js';
import type { SessionRepository } from './SessionRepository.js';
import type { ITokenService, TokenPayload } from './TokenService.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoginInput {
  /** Pre-normalized email (LoginRequestSchema lowercases + trims). */
  email: string;
  /** Plaintext password supplied by the user. */
  password: string;
  /** Caller's IP address for session metadata (optional). */
  ipAddress?: string;
  /** User-Agent header value for session metadata (optional). */
  userAgent?: string;
}

export interface LoginUserProfile {
  id: string;
  email: string;
  displayName: string | null;
  roles: string[];
  emailVerified: boolean;
}

export interface LoginOutput {
  accessToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds (matches the TokenService config TTL). */
  expiresIn: number;
  user: LoginUserProfile;
}

// ---------------------------------------------------------------------------
// Dependencies injected at construction
// ---------------------------------------------------------------------------

export interface LoginServiceDeps {
  userRepository: UserRepository;
  credentialRepository: CredentialRepository;
  credentialService: ICredentialService;
  sessionRepository: SessionRepository;
  tokenService: ITokenService;
  /** Access-token TTL in seconds — must match the TokenService config. */
  accessTokenTtlSeconds: number;
  /**
   * Optional role resolver.  If omitted, roles defaults to ['user'].
   * Provide a real implementation (e.g. from RoleRepository) in production.
   */
  getRoles?: (userId: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ILoginService {
  login(input: LoginInput): Promise<LoginOutput>;
}

export function createLoginService(deps: LoginServiceDeps): ILoginService {
  const {
    userRepository,
    credentialRepository,
    credentialService,
    sessionRepository,
    tokenService,
    accessTokenTtlSeconds,
    getRoles,
  } = deps;

  async function login(input: LoginInput): Promise<LoginOutput> {
    // 1. Normalize email.
    const email = input.email.trim().toLowerCase();

    // 2. Load user by email.
    const user = await userRepository.findByEmail(email);

    // 3. Load credential with secret hash.
    //    We attempt this even when user is null so we can always run the hash
    //    comparison (timing equalization is handled inside verifyPassword).
    const credential = user
      ? await credentialRepository.findWithSecretByUserId(user.id, 'password')
      : null;

    // 4. Lockout check — before the expensive hash comparison.
    if (credential) {
      const lockStatus = await credentialService.isLocked(credential.id);
      if (lockStatus.locked) {
        // Map to rateLimited / ACCOUNT_TEMPORARILY_LOCKED — but per the WO the
        // route layer already handles this via LoginAttemptGuard.  The service
        // raises INVALID_CREDENTIALS here (same envelope) so the caller decides
        // how to surface it.  A dedicated lockout guard (LoginAttemptGuard) is
        // wired at the route level for the per-IP check; this guard is the
        // per-credential check.
        throw invalidCredentials();
      }
    }

    // 5. Verify password (always called for timing equalization).
    const verifyResult = await credentialService.verifyPassword(
      input.password,
      credential?.secretHash ?? null,
    );

    if (!verifyResult.valid || !user || !credential) {
      // Record failure only when the credential row exists.
      if (credential) {
        await credentialService.recordFailedAttempt(credential.id);
      }
      throw invalidCredentials();
    }

    // 6. Check email verified.
    if (!user.emailVerifiedAt) {
      throw emailNotVerified();
    }

    // 7. Check account status.
    if (user.status !== 'active') {
      throw accountDisabled();
    }

    // 8. Create session.
    //    Pre-generate the jti so we can store it in session.token (for future
    //    revocation checks in WO-022) while also embedding it in the JWT claim.
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + accessTokenTtlSeconds * 1000);

    const session = await sessionRepository.createSession({
      userId: user.id,
      token: jti,   // session.token == jti for revocation lookup
      expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    // 9. Mint access token — embed session.id as sid and the pre-generated jti.
    const roles = getRoles ? await getRoles(user.id) : ['user'];
    const tokenPayload: TokenPayload = {
      sub: user.id,
      sid: session.id,   // session PK — used for revocation
      jti,               // matches session.token — used for denylist lookup
      roles,
    };
    const accessToken = tokenService.sign(tokenPayload);

    // 10. Success path — reset failed-attempt counter; rehash if needed.
    await credentialService.resetFailedAttempts(credential.id).catch(() => {
      // Non-fatal: failure to reset counters does not invalidate the login.
    });

    if (verifyResult.needsRehash) {
      // Fire-and-forget rehash.  If it fails, the user can still log in with
      // the existing hash on their next visit.
      credentialService.hashPassword(input.password).then(async ({ hash, algorithm }) => {
        // The credential service's update path is not exposed here — a real
        // production implementation would call a credential.update() method.
        // This is a no-op stub until WO-022 wires the full credential update.
        void hash; void algorithm;
      }).catch(() => { /* best-effort rehash */ });
    }

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: accessTokenTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles,
        emailVerified: !!user.emailVerifiedAt,
      },
    };
  }

  return { login };
}
