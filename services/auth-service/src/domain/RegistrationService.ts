/**
 * RegistrationService — account creation with email-verification token issuance.
 *
 * Security invariants:
 * - All three branches (new, existing-unverified, existing-verified) return the
 *   same generic result — email enumeration is prevented by design.
 * - User creation, credential creation and default role assignment are wrapped
 *   in a single database transaction.  Any failure rolls back completely.
 * - Verification tokens are generated from 32 bytes of CSPRNG, base64url-encoded;
 *   only the SHA-256 hash is persisted.
 * - Email dispatch happens AFTER the transaction commits so a failed transaction
 *   never produces a live token.  Mailer failures are logged and never surface
 *   as a request error.
 * - Tokens are never written to logs or returned in API responses.
 */

import { createHash, randomBytes } from "node:crypto";
import { REGISTRATION_ACCEPTED_MESSAGE } from "@travel/contracts";
import type { Mailer } from "../mailer/Mailer.js";

const PURPOSE_EMAIL_VERIFICATION = "email_verification";
const DEFAULT_ROLE_NAME = "traveler";
const TOKEN_EXPIRY_MINUTES = 24 * 60; // 24 hours
const RAW_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Minimal DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

interface UserSafeRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: string;
}

interface RegistrationDbClient {
  user: {
    findUnique(args: {
      where: { email: string };
      select: { id: true; email: true; emailVerifiedAt: true; status: true };
    }): Promise<UserSafeRecord | null>;
    create(args: {
      data: { email: string; displayName?: string | null; status: string };
      select: { id: true; email: true; emailVerifiedAt: true; status: true };
    }): Promise<UserSafeRecord>;
  };
  credential: {
    create(args: {
      data: {
        userId: string;
        type: string;
        secretHash: string;
        hashAlgorithm: string;
      };
    }): Promise<{ id: string }>;
  };
  role: {
    findFirst(args: {
      where: { name: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  userRole: {
    create(args: {
      data: { userId: string; roleId: string };
    }): Promise<{ userId: string; roleId: string }>;
  };
  oneTimeToken: {
    create(args: {
      data: {
        userId: string;
        purpose: string;
        tokenHash: string;
        expiresAt: Date;
      };
    }): Promise<{ id: string }>;
    updateMany(args: {
      where: { userId: string; purpose: string; consumedAt: null };
      data: { consumedAt: Date };
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: RegistrationDbClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Dependencies and types
// ---------------------------------------------------------------------------

export interface RegistrationDeps {
  db: RegistrationDbClient;
  mailer: Mailer;
  /** Injected credential hasher — must not be called inside the transaction body. */
  hashPassword(password: string): Promise<{ hash: string; algorithm: string }>;
  /** Policy validation — call before entering the transaction. */
  validatePasswordPolicy(password: string, emailLocalPart?: string): { valid: boolean; violations: Array<{ rule: string; message: string }> };
  tokenExpiryMinutes?: number;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
}

export interface RegisterResult {
  message: string;
}

export interface RegistrationService {
  register(input: RegisterInput): Promise<RegisterResult>;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistrationService(deps: RegistrationDeps): RegistrationService {
  const { db, mailer, hashPassword, validatePasswordPolicy, logger } = deps;
  const expiryMinutes = deps.tokenExpiryMinutes ?? TOKEN_EXPIRY_MINUTES;

  async function issueVerificationToken(userId: string, tx: RegistrationDbClient): Promise<string> {
    // Invalidate any outstanding verification tokens before issuing a fresh one.
    await tx.oneTimeToken.updateMany({
      where: { userId, purpose: PURPOSE_EMAIL_VERIFICATION, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    await tx.oneTimeToken.create({
      data: { userId, purpose: PURPOSE_EMAIL_VERIFICATION, tokenHash, expiresAt },
    });

    return rawToken;
  }

  return {
    async register(input: RegisterInput): Promise<RegisterResult> {
      const email = input.email.trim().toLowerCase();
      const emailLocalPart = email.split("@")[0] ?? "";

      // 1. Validate password policy BEFORE touching the database.
      const policyResult = validatePasswordPolicy(input.password, emailLocalPart);
      if (!policyResult.valid) {
        // Re-throw as a structured domain error so the route can return 422.
        const err = Object.assign(new Error("Password policy violation"), {
          code: "POLICY_VIOLATION" as const,
          violations: policyResult.violations,
        });
        throw err;
      }

      // 2. Hash the password BEFORE the transaction (scrypt is CPU-intensive).
      const { hash: secretHash, algorithm: hashAlgorithm } = await hashPassword(input.password);

      // Build display name from inputs.
      const displayName =
        input.displayName?.trim() ||
        [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(" ") ||
        null;

      // 3. Look up existing user outside the transaction first (read-only).
      const existing = await db.user.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerifiedAt: true, status: true },
      });

      let rawToken: string | null = null;
      let isNewUser = false;
      let existingVerified = false;
      let userId: string | null = null;

      if (existing === null) {
        // --- BRANCH A: New user ---
        isNewUser = true;
        await db.$transaction(async (tx) => {
          // Create user with status=pending.
          const user = await tx.user.create({
            data: { email, displayName, status: "pending" },
            select: { id: true, email: true, emailVerifiedAt: true, status: true },
          });
          userId = user.id;

          // Create credential row.
          await tx.credential.create({
            data: {
              userId: user.id,
              type: "password",
              secretHash,
              hashAlgorithm,
            },
          });

          // Assign default role.
          const role = await tx.role.findFirst({
            where: { name: DEFAULT_ROLE_NAME },
            select: { id: true },
          });
          if (role) {
            await tx.userRole.create({
              data: { userId: user.id, roleId: role.id },
            });
          } else {
            logger?.warn(
              { event: "auth.registration.role_not_found", roleName: DEFAULT_ROLE_NAME },
              "Default role not found — user created without role assignment",
            );
          }

          // Issue verification token inside the transaction.
          rawToken = await issueVerificationToken(user.id, tx);
        });

        logger?.info(
          { event: "auth.registration.new_user", userId },
          "New user registered — verification email queued",
        );
      } else if (existing.emailVerifiedAt === null) {
        // --- BRANCH B: Existing unverified account — resend token ---
        userId = existing.id;
        // Issue a fresh token (outside $transaction is fine — only a token write).
        rawToken = await issueVerificationToken(existing.id, db);

        logger?.info(
          { event: "auth.registration.resend_unverified", userId },
          "Resent verification email for unverified account",
        );
      } else {
        // --- BRANCH C: Existing verified account — security notice ---
        userId = existing.id;
        existingVerified = true;

        logger?.warn(
          { event: "auth.registration.duplicate_verified", userId },
          "Registration attempt for already-verified account",
        );
      }

      // 4. Dispatch email AFTER commit (never inside the transaction).
      //    Mailer failures must not roll back or error the response.
      if (rawToken !== null) {
        mailer
          .sendVerificationEmail({ to: email, verificationToken: rawToken, expiresInMinutes: expiryMinutes })
          .catch((err: unknown) => {
            logger?.error(
              { event: "auth.registration.mailer_failed", userId, err },
              "Failed to send verification email — token committed but email not delivered",
            );
          });
      } else if (existingVerified) {
        mailer.sendRegistrationAttemptNotice({ to: email }).catch((err: unknown) => {
          logger?.error(
            { event: "auth.registration.notice_mailer_failed", userId, err },
            "Failed to send registration attempt notice",
          );
        });
      }

      // 5. Always return the same generic message (enumeration-safe).
      return { message: REGISTRATION_ACCEPTED_MESSAGE };
    },
  };
}
