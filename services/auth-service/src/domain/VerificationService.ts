/**
 * VerificationService — email-verification token consumption and resend.
 *
 * Security invariants:
 * - Token consumption is atomic: email_verified_at, status=active and
 *   consumed_at are updated in one transaction.
 * - All other outstanding verification tokens for the user are invalidated
 *   when any one is successfully consumed.
 * - Unknown, expired and already-consumed tokens all return the same generic
 *   error code (INVALID_OR_EXPIRED_TOKEN) — token existence is not disclosed.
 * - A consumed token for an already-verified user is idempotent (returns
 *   verified:true rather than erroring the client).
 * - Resend always returns 202 regardless of account state (enumeration-safe).
 */

import { createHash, randomBytes } from "node:crypto";
import { invalidOrExpiredToken } from "@travel/contracts";
import type { Mailer } from "../mailer/Mailer.js";

const PURPOSE_EMAIL_VERIFICATION = "email_verification";
const DEFAULT_EXPIRY_MINUTES = 24 * 60; // 24 hours
const RAW_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// DB client interface (duck-typed)
// ---------------------------------------------------------------------------

interface TokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface UserSafeRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: string;
}

interface VerificationDbClient {
  oneTimeToken: {
    findFirst(args: {
      where: { tokenHash: string; purpose: string };
      select: { id: true; userId: true; expiresAt: true; consumedAt: true };
    }): Promise<TokenRecord | null>;
    updateMany(args: {
      where: { id?: string; userId?: string; purpose?: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }>;
    create(args: {
      data: { userId: string; purpose: string; tokenHash: string; expiresAt: Date };
    }): Promise<{ id: string }>;
  };
  user: {
    findUnique(args: {
      where: { email: string } | { id: string };
      select: { id: true; email: true; emailVerifiedAt: true; status: true };
    }): Promise<UserSafeRecord | null>;
    update(args: {
      where: { id: string };
      data: { emailVerifiedAt: Date; status: string; updatedAt: Date };
      select: { id: true; email: true; emailVerifiedAt: true; status: true };
    }): Promise<UserSafeRecord>;
  };
  $transaction<T>(fn: (tx: VerificationDbClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface VerificationServiceDeps {
  db: VerificationDbClient;
  mailer: Mailer;
  tokenExpiryMinutes?: number;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface VerifyEmailResult {
  verified: true;
}

export interface VerificationService {
  verifyEmail(rawToken: string): Promise<VerifyEmailResult>;
  resendVerification(email: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
  const { db, mailer, logger } = deps;
  const expiryMinutes = deps.tokenExpiryMinutes ?? DEFAULT_EXPIRY_MINUTES;

  return {
    async verifyEmail(rawToken: string): Promise<VerifyEmailResult> {
      const tokenHash = hashToken(rawToken);
      const now = new Date();

      const tokenRecord = await db.oneTimeToken.findFirst({
        where: { tokenHash, purpose: PURPOSE_EMAIL_VERIFICATION },
        select: { id: true, userId: true, expiresAt: true, consumedAt: true },
      });

      // Missing, expired, or already-consumed tokens all produce the same error
      // (do not reveal which case applies).
      if (tokenRecord === null || tokenRecord.expiresAt < now) {
        throw invalidOrExpiredToken();
      }

      // Idempotency: if the token was already consumed but the user is verified,
      // return success rather than erroring the client into a broken state.
      if (tokenRecord.consumedAt !== null) {
        const user = await db.user.findUnique({
          where: { id: tokenRecord.userId },
          select: { id: true, email: true, emailVerifiedAt: true, status: true },
        });
        if (user?.emailVerifiedAt !== null) {
          return { verified: true };
        }
        // Token consumed but user not verified — someone else consumed it; reject.
        throw invalidOrExpiredToken();
      }

      // Atomically verify the account.
      await db.$transaction(async (tx) => {
        // Mark this token consumed.
        await tx.oneTimeToken.updateMany({
          where: { id: tokenRecord.id, consumedAt: null },
          data: { consumedAt: now },
        });

        // Invalidate all other outstanding verification tokens for this user.
        await tx.oneTimeToken.updateMany({
          where: { userId: tokenRecord.userId, purpose: PURPOSE_EMAIL_VERIFICATION, consumedAt: null },
          data: { consumedAt: now },
        });

        // Activate the user.
        await tx.user.update({
          where: { id: tokenRecord.userId },
          data: { emailVerifiedAt: now, status: "active", updatedAt: now },
          select: { id: true, email: true, emailVerifiedAt: true, status: true },
        });
      });

      logger?.info(
        { event: "auth.email_verified", userId: tokenRecord.userId },
        "Email verified and account activated",
      );

      return { verified: true };
    },

    async resendVerification(email: string): Promise<void> {
      const normalizedEmail = email.trim().toLowerCase();

      // Look up account — always returns generic 202 regardless of outcome.
      const user = await db.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, email: true, emailVerifiedAt: true, status: true },
      });

      if (user === null) {
        // Account does not exist — silently succeed (enumeration-safe).
        return;
      }

      if (user.emailVerifiedAt !== null) {
        // Already verified — send a security notice instead.
        mailer.sendRegistrationAttemptNotice({ to: normalizedEmail }).catch((err: unknown) => {
          logger?.error(
            { event: "auth.resend_verification.notice_mailer_failed", userId: user.id, err },
            "Failed to send registration attempt notice on resend",
          );
        });
        return;
      }

      // Issue a fresh token.
      // Invalidate outstanding tokens first.
      await db.oneTimeToken.updateMany({
        where: { userId: user.id, purpose: PURPOSE_EMAIL_VERIFICATION, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      const rawToken = generateRawToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

      await db.oneTimeToken.create({
        data: { userId: user.id, purpose: PURPOSE_EMAIL_VERIFICATION, tokenHash, expiresAt },
      });

      mailer
        .sendVerificationEmail({
          to: normalizedEmail,
          verificationToken: rawToken,
          expiresInMinutes: expiryMinutes,
        })
        .catch((err: unknown) => {
          logger?.error(
            { event: "auth.resend_verification.mailer_failed", userId: user.id, err },
            "Failed to send resent verification email",
          );
        });

      logger?.info(
        { event: "auth.resend_verification.sent", userId: user.id },
        "Verification email resent",
      );
    },
  };
}
