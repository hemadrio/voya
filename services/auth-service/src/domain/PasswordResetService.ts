/**
 * PasswordResetService — forgot-password and reset-password flows.
 *
 * Security requirements:
 * - Enumeration-safe: responds 202 regardless of whether the email exists.
 * - Tokens: SHA-256 hashed, single-use, short-lived (default 1 hour).
 * - All outstanding reset tokens for a user are invalidated when one is
 *   consumed or the password changes.
 * - Password reset is a single transaction: hash update + lockout clear +
 *   token consumption + sibling token invalidation + session revoke.
 * - Mailer failures after commit are logged and never surface as errors.
 * - Reset tokens are never logged or echoed in responses.
 */

import { createHash, randomBytes } from "node:crypto";
import { invalidOrExpiredToken, passwordReuseNotAllowed } from "@travel/contracts";
import { hashPassword, verifyPassword } from "../crypto/password.js";
import type { Mailer } from "../mailer/Mailer.js";

const PURPOSE_PASSWORD_RESET = "password_reset";
const TOKEN_EXPIRY_MINUTES = 60;
const RAW_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Minimal DB client interface (duck-typed — no Prisma import)
// ---------------------------------------------------------------------------

interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}

interface TokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface PasswordResetDbClient {
  user: {
    findUnique(args: { where: { email: string } | { id: string } }): Promise<UserRecord | null>;
    update(args: {
      where: { id: string };
      data: { passwordHash: string; failedAttemptCount: number; lockedUntil: null; updatedAt: Date };
    }): Promise<unknown>;
  };
  oneTimeToken: {
    create(args: {
      data: { userId: string; purpose: string; tokenHash: string; expiresAt: Date };
    }): Promise<{ id: string }>;
    findFirst(args: {
      where: { tokenHash: string; purpose: string };
    }): Promise<TokenRecord | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  session: {
    updateMany(args: { where: { userId: string; revokedAt: null }; data: { revokedAt: Date } }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: PasswordResetDbClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface PasswordResetServiceDeps {
  db: PasswordResetDbClient;
  mailer: Mailer;
  tokenExpiryMinutes?: number;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface PasswordResetService {
  /**
   * Issue a password reset token for the given email if an account exists.
   * Always returns silently regardless of account existence (enumeration-safe).
   * Token issuance and mail sending happen asynchronously after the call returns
   * so response timing is uniform.
   */
  forgotPassword(email: string): Promise<void>;

  /**
   * Consume the reset token and atomically update the password.
   *
   * Single transaction: validate token → reject reuse → write hash
   * → clear lockout → consume token → invalidate sibling tokens → revoke sessions.
   *
   * Throws DomainError on:
   * - INVALID_OR_EXPIRED_TOKEN — unknown/expired/consumed token
   * - PASSWORD_REUSE_NOT_ALLOWED — new password identical to current
   * - VALIDATION_FAILED — password policy rejection (thrown before this call)
   */
  resetPassword(rawToken: string, newPassword: string): Promise<void>;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function createPasswordResetService(deps: PasswordResetServiceDeps): PasswordResetService {
  const { db, mailer, logger } = deps;
  const expiryMinutes = deps.tokenExpiryMinutes ?? TOKEN_EXPIRY_MINUTES;

  async function issueTokenAndSendMail(userId: string, email: string): Promise<void> {
    const rawToken = randomBytes(RAW_TOKEN_BYTES).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Invalidate any outstanding reset tokens before creating a new one.
    await db.oneTimeToken.updateMany({
      where: { userId, purpose: PURPOSE_PASSWORD_RESET, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await db.oneTimeToken.create({
      data: { userId, purpose: PURPOSE_PASSWORD_RESET, tokenHash, expiresAt },
    });

    logger?.info({ event: "auth.reset_requested", userId }, "Password reset token issued");

    try {
      await mailer.sendPasswordResetLink({ to: email, resetToken: rawToken, expiresInMinutes: expiryMinutes });
    } catch (err) {
      logger?.error({ event: "auth.mailer_failed", err }, "Failed to send password reset email");
    }
  }

  return {
    async forgotPassword(email: string): Promise<void> {
      const user = await db.user.findUnique({ where: { email } });

      if (user === null) {
        // Return immediately — timing equalization happens because the async
        // work fires off and we respond before it completes regardless.
        return;
      }

      // Fire-and-forget: respond first so timing is uniform whether or not
      // the account exists. Failures are logged, not thrown.
      issueTokenAndSendMail(user.id, user.email).catch((err) => {
        logger?.error({ event: "auth.reset_issue_failed", err }, "Failed to issue reset token");
      });
    },

    async resetPassword(rawToken: string, newPassword: string): Promise<void> {
      const tokenHash = hashToken(rawToken);

      let emailForNotification: string | undefined;

      await db.$transaction(async (tx) => {
        const tokenRecord = await tx.oneTimeToken.findFirst({
          where: { tokenHash, purpose: PURPOSE_PASSWORD_RESET },
        });

        if (
          tokenRecord === null ||
          tokenRecord.consumedAt !== null ||
          tokenRecord.expiresAt < new Date()
        ) {
          throw invalidOrExpiredToken();
        }

        const userId = tokenRecord.userId;

        const currentUser = await tx.user.findUnique({ where: { id: userId } });
        if (currentUser === null) {
          throw invalidOrExpiredToken();
        }

        const isReuse = await verifyPassword(newPassword, currentUser.passwordHash);
        if (isReuse) {
          throw passwordReuseNotAllowed();
        }

        const newHash = await hashPassword(newPassword);

        await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash: newHash,
            failedAttemptCount: 0,
            lockedUntil: null,
            updatedAt: new Date(),
          },
        });

        // Consume this token.
        await tx.oneTimeToken.updateMany({
          where: { id: tokenRecord.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });

        // Invalidate all other outstanding reset tokens for this user.
        await tx.oneTimeToken.updateMany({
          where: { userId, purpose: PURPOSE_PASSWORD_RESET, consumedAt: null },
          data: { consumedAt: new Date() },
        });

        // Revoke all sessions — a compromised session must not survive a reset.
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        emailForNotification = currentUser.email;
        logger?.info({ event: "auth.reset_completed", userId }, "Password reset completed");
      });

      // Send notification after transaction commits — failures are logged, not thrown.
      if (typeof emailForNotification === "string") {
        mailer.sendPasswordChangedNotice({ to: emailForNotification }).catch((err) => {
          logger?.error({ event: "auth.mailer_failed", err }, "Failed to send password changed notice");
        });
      }
    },
  };
}
