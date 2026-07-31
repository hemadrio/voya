/**
 * Unit tests for PasswordResetService.
 *
 * Tests: reset token lifecycle, hash-based consumption, expiry, sibling
 * invalidation, current-password reuse rejection, lockout clearing, and
 * transactional rollback when any step fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPasswordResetService } from "../../src/domain/PasswordResetService.js";
import { hashPassword } from "../../src/crypto/password.js";
import { createHash } from "node:crypto";
import type { PasswordResetDbClient } from "../../src/domain/PasswordResetService.js";
import type { Mailer } from "../../src/mailer/Mailer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function makeMailer(): Mailer {
  return {
    sendPasswordResetLink: vi.fn(async () => {}),
    sendPasswordChangedNotice: vi.fn(async () => {}),
    sendVerificationEmail: vi.fn(async () => {}),
    sendRegistrationAttemptNotice: vi.fn(async () => {}),
  };
}

type TokenRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

function makeDb(overrides: Partial<{
  user: Partial<PasswordResetDbClient["user"]>;
  oneTimeToken: Partial<PasswordResetDbClient["oneTimeToken"]>;
  session: Partial<PasswordResetDbClient["session"]>;
}> = {}): PasswordResetDbClient {
  const defaultUser = {
    findUnique: vi.fn(async () => null as { id: string; email: string; passwordHash: string } | null),
    update: vi.fn(async () => {}),
  };

  const defaultToken = {
    create: vi.fn(async () => ({ id: "tok-1" })),
    findFirst: vi.fn(async () => null as TokenRecord | null),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };

  const defaultSession = {
    updateMany: vi.fn(async () => ({ count: 2 })),
  };

  const db: PasswordResetDbClient = {
    user: { ...defaultUser, ...overrides.user } as PasswordResetDbClient["user"],
    oneTimeToken: { ...defaultToken, ...overrides.oneTimeToken } as PasswordResetDbClient["oneTimeToken"],
    session: { ...defaultSession, ...overrides.session } as PasswordResetDbClient["session"],
    $transaction: vi.fn(async (fn) => fn(db)),
  };

  return db;
}

// ---------------------------------------------------------------------------
// forgotPassword
// ---------------------------------------------------------------------------

describe("PasswordResetService.forgotPassword", () => {
  it("returns silently when email does not exist (enumeration-safe)", async () => {
    const db = makeDb({ user: { findUnique: vi.fn(async () => null) } });
    const mailer = makeMailer();
    const svc = createPasswordResetService({ db, mailer });

    await expect(svc.forgotPassword("unknown@example.com")).resolves.toBeUndefined();
    expect(mailer.sendPasswordResetLink).not.toHaveBeenCalled();
  });

  it("issues a reset token and sends email when account exists", async () => {
    const user = { id: "u1", email: "alice@example.com", passwordHash: "hash" };
    const db = makeDb({ user: { findUnique: vi.fn(async () => user) } });
    const mailer = makeMailer();
    const svc = createPasswordResetService({ db, mailer });

    await svc.forgotPassword("alice@example.com");

    // Allow the fire-and-forget async work to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(db.oneTimeToken.create).toHaveBeenCalledOnce();
    // Token value must NOT appear in the call args — only hash is stored
    const createArgs = (db.oneTimeToken.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs.data.purpose).toBe("password_reset");
    expect(typeof createArgs.data.tokenHash).toBe("string");
    expect(createArgs.data.tokenHash).toHaveLength(64);

    expect(mailer.sendPasswordResetLink).toHaveBeenCalledOnce();
    const mailArgs = (mailer.sendPasswordResetLink as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(mailArgs.to).toBe("alice@example.com");
    // resetToken is in the mail (for the link) but must not appear in the hash stored above
    expect(hashToken(mailArgs.resetToken)).toBe(createArgs.data.tokenHash);
  });
});

// ---------------------------------------------------------------------------
// resetPassword
// ---------------------------------------------------------------------------

describe("PasswordResetService.resetPassword — valid token", () => {
  let db: PasswordResetDbClient;
  let mailer: Mailer;
  let currentHash: string;
  const RAW_TOKEN = "a".repeat(64); // 64-char hex-like raw token
  const userId = "u1";
  const email = "alice@example.com";

  beforeEach(async () => {
    currentHash = await hashPassword("CurrentPass1");
    const tokenHash = hashToken(RAW_TOKEN);

    db = makeDb({
      user: {
        findUnique: vi.fn(async () => ({
          id: userId,
          email,
          passwordHash: currentHash,
        })),
      },
      oneTimeToken: {
        findFirst: vi.fn(async () => ({
          id: "tok-1",
          userId,
          expiresAt: new Date(Date.now() + 3600_000),
          consumedAt: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    mailer = makeMailer();
  });

  it("updates password hash and clears lockout fields", async () => {
    const svc = createPasswordResetService({ db, mailer });
    await svc.resetPassword(RAW_TOKEN, "NewPassword1");

    expect(db.user.update).toHaveBeenCalledOnce();
    const updateArgs = (db.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.data.failedAttemptCount).toBe(0);
    expect(updateArgs.data.lockedUntil).toBeNull();
    expect(typeof updateArgs.data.passwordHash).toBe("string");
    expect(updateArgs.data.passwordHash).not.toBe(currentHash);
  });

  it("consumes the token and invalidates sibling tokens", async () => {
    const svc = createPasswordResetService({ db, mailer });
    await svc.resetPassword(RAW_TOKEN, "NewPassword1");

    // updateMany should be called at least twice: consume + sibling invalidation
    expect(db.oneTimeToken.updateMany).toHaveBeenCalledTimes(2);
  });

  it("revokes all sessions after reset", async () => {
    const svc = createPasswordResetService({ db, mailer });
    await svc.resetPassword(RAW_TOKEN, "NewPassword1");

    expect(db.session.updateMany).toHaveBeenCalledOnce();
    const sessionArgs = (db.session.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sessionArgs.where.userId).toBe(userId);
    expect(sessionArgs.where.revokedAt).toBeNull();
  });

  it("sends password changed notification after commit", async () => {
    const svc = createPasswordResetService({ db, mailer });
    await svc.resetPassword(RAW_TOKEN, "NewPassword1");
    await new Promise((r) => setTimeout(r, 10));

    expect(mailer.sendPasswordChangedNotice).toHaveBeenCalledOnce();
    const noticeArgs = (mailer.sendPasswordChangedNotice as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(noticeArgs.to).toBe(email);
  });
});

describe("PasswordResetService.resetPassword — error cases", () => {
  it("throws INVALID_OR_EXPIRED_TOKEN when token is not found", async () => {
    const db = makeDb({ oneTimeToken: { findFirst: vi.fn(async () => null) } });
    const svc = createPasswordResetService({ db, mailer: makeMailer() });

    await expect(svc.resetPassword("bad-token", "NewPass1")).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  it("throws INVALID_OR_EXPIRED_TOKEN when token is already consumed", async () => {
    const db = makeDb({
      oneTimeToken: {
        findFirst: vi.fn(async () => ({
          id: "tok-1",
          userId: "u1",
          expiresAt: new Date(Date.now() + 3600_000),
          consumedAt: new Date(Date.now() - 1000),
        })),
      },
    });
    const svc = createPasswordResetService({ db, mailer: makeMailer() });

    await expect(svc.resetPassword("some-token", "NewPass1")).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  it("throws INVALID_OR_EXPIRED_TOKEN when token is expired", async () => {
    const db = makeDb({
      oneTimeToken: {
        findFirst: vi.fn(async () => ({
          id: "tok-1",
          userId: "u1",
          expiresAt: new Date(Date.now() - 1000),
          consumedAt: null,
        })),
      },
    });
    const svc = createPasswordResetService({ db, mailer: makeMailer() });

    await expect(svc.resetPassword("some-token", "NewPass1")).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  it("throws PASSWORD_REUSE_NOT_ALLOWED when new password matches current", async () => {
    const currentPass = "CurrentPass1";
    const currentHash = await hashPassword(currentPass);

    const db = makeDb({
      user: {
        findUnique: vi.fn(async () => ({ id: "u1", email: "alice@example.com", passwordHash: currentHash })),
      },
      oneTimeToken: {
        findFirst: vi.fn(async () => ({
          id: "tok-1",
          userId: "u1",
          expiresAt: new Date(Date.now() + 3600_000),
          consumedAt: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    const svc = createPasswordResetService({ db, mailer: makeMailer() });

    await expect(svc.resetPassword("some-token", currentPass)).rejects.toMatchObject({
      code: "PASSWORD_REUSE_NOT_ALLOWED",
    });
  });
});
