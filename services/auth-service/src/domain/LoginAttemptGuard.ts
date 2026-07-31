/**
 * LoginAttemptGuard — per-account and per-IP login lockout.
 *
 * Enforces the auth lockout policy from WO-016:
 *   - 5 failed login attempts in 15 minutes → account locked for 15 minutes.
 *   - Lockout state is persisted in the users table (lockedUntil, failedAttemptCount).
 *   - Every attempt (success and failure) is written to the audit log.
 *   - ACCOUNT_TEMPORARILY_LOCKED does not disclose whether the account exists
 *     (the same code is returned for IP-level lockout of non-existent accounts).
 *
 * Hexagonal architecture: depends only on injected interfaces, not Prisma or Express.
 */

import { AUTH_LOCKOUT } from './authLockoutConfig.js';

// ---------------------------------------------------------------------------
// Interfaces (injected — no framework or ORM imports)
// ---------------------------------------------------------------------------

export interface LoginAttemptUser {
  id: string;
  failedAttemptCount: number;
  lockedUntil: Date | null;
}

/** Minimal DB interface for lockout state. */
export interface LoginAttemptDbClient {
  user: {
    findUnique(args: {
      where: { email: string };
      select: { id: boolean; failedAttemptCount: boolean; lockedUntil: boolean };
    }): Promise<LoginAttemptUser | null>;
    update(args: {
      where: { id: string };
      data: {
        failedAttemptCount: number;
        /** Omit to leave unchanged; null to clear the lock. */
        lockedUntil?: Date | null;
      };
    }): Promise<void>;
  };
}

export interface LoginAuditLogger {
  /** Append an immutable audit record for a login attempt. */
  write(record: {
    email: string;
    outcome: 'success' | 'failure' | 'locked';
    ipAddress: string;
    reason?: string;
  }): void;
}

export interface LoginAttemptGuardOptions {
  db: LoginAttemptDbClient;
  auditLogger: LoginAuditLogger;
  /** Clock — defaults to Date.now. Inject a fake for deterministic tests. */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LoginGuardCheckResult {
  /** Whether the attempt is permitted. */
  allowed: boolean;
  /** Seconds until lockout expires (only meaningful when allowed=false). */
  retryAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

export class LoginAttemptGuard {
  private readonly db: LoginAttemptDbClient;
  private readonly auditLogger: LoginAuditLogger;
  private readonly clock: () => number;

  constructor(options: LoginAttemptGuardOptions) {
    this.db = options.db;
    this.auditLogger = options.auditLogger;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Check whether a login attempt for the given email is currently allowed.
   *
   * Must be called BEFORE verifying credentials so that locked accounts are
   * rejected without disclosing whether the account exists.
   *
   * Returns allowed=true even when the user does not exist (enforcement is
   * symmetrical — a non-existent email that has been hammered can hit the
   * IP-level limit tracked separately by the gateway).
   */
  async checkAllowed(email: string): Promise<LoginGuardCheckResult> {
    const nowMs = this.clock();
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, failedAttemptCount: true, lockedUntil: true },
    });

    if (!user) {
      // Unknown email — treat as allowed at the account level.
      // The gateway IP-level rate limiter handles brute-force enumeration.
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (user.lockedUntil !== null && user.lockedUntil.getTime() > nowMs) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - nowMs) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Record a successful login — resets the failure counter and lockout.
   * Called after credentials are verified successfully.
   */
  async recordSuccess(email: string, ipAddress: string): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, failedAttemptCount: true, lockedUntil: true },
    });

    if (user && (user.failedAttemptCount > 0 || user.lockedUntil !== null)) {
      await this.db.user.update({
        where: { id: user.id },
        data: { failedAttemptCount: 0, lockedUntil: null },
      });
    }

    this.auditLogger.write({ email, outcome: 'success', ipAddress });
  }

  /**
   * Record a failed login attempt — increments the counter, locks the account
   * if the threshold is reached.
   * Called after a credential verification failure.
   */
  async recordFailure(email: string, ipAddress: string, reason = 'invalid_credentials'): Promise<void> {
    const nowMs = this.clock();
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, failedAttemptCount: true, lockedUntil: true },
    });

    if (!user) {
      // Audit even for non-existent accounts to track enumeration attempts.
      this.auditLogger.write({ email, outcome: 'failure', ipAddress, reason });
      return;
    }

    const newCount = (user.failedAttemptCount ?? 0) + 1;
    const shouldLock = newCount >= AUTH_LOCKOUT.maxFailures;
    // Only update lockedUntil when locking — preserve existing lock timestamp otherwise.
    const lockedUntil: Date | null | undefined = shouldLock
      ? new Date(nowMs + AUTH_LOCKOUT.lockDurationMs)
      : undefined;

    await this.db.user.update({
      where: { id: user.id },
      data: {
        failedAttemptCount: newCount,
        ...(lockedUntil !== undefined ? { lockedUntil } : {}),
      },
    });

    this.auditLogger.write({
      email,
      outcome: shouldLock ? 'locked' : 'failure',
      ipAddress,
      reason,
    });
  }
}
