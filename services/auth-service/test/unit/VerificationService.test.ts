/**
 * Unit tests for VerificationService.
 *
 * Covers: token consumption + account activation, expiry, consumed-idempotency,
 * consumed-but-unverified rejection, resend branches (unknown/unverified/verified).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createVerificationService } from "../../src/domain/VerificationService.js";
import { InMemoryMailer } from "../../src/mailer/Mailer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const RAW_TOKEN = "test-raw-token-32bytes-padding-xx";
const TOKEN_HASH = hashToken(RAW_TOKEN);

type TokenRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

type UserRecord = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: string;
};

function futureDate(offsetMs = 24 * 60 * 60 * 1000): Date {
  return new Date(Date.now() + offsetMs);
}

function pastDate(offsetMs = 24 * 60 * 60 * 1000): Date {
  return new Date(Date.now() - offsetMs);
}

function makeValidToken(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: "tok-1",
    userId: "user-1",
    expiresAt: futureDate(),
    consumedAt: null,
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    email: "alice@example.com",
    emailVerifiedAt: null,
    status: "pending",
    ...overrides,
  };
}

// Build a minimal duck-typed db mock.
function makeDb(overrides: {
  tokenRecord?: TokenRecord | null;
  userRecord?: UserRecord | null;
} = {}) {
  const tokenRecord = overrides.tokenRecord !== undefined ? overrides.tokenRecord : makeValidToken();
  const userRecord = overrides.userRecord !== undefined ? overrides.userRecord : makeUser();

  const updateMany = vi.fn(async () => ({ count: 1 }));
  const userUpdate = vi.fn(async () => ({ ...userRecord, emailVerifiedAt: new Date(), status: "active" }));

  const txFn = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      oneTimeToken: { updateMany },
      user: { update: userUpdate },
    }),
  );

  return {
    oneTimeToken: {
      findFirst: vi.fn(async () => tokenRecord),
      updateMany,
      create: vi.fn(async () => ({ id: "tok-new" })),
    },
    user: {
      findUnique: vi.fn(async () => userRecord),
      update: userUpdate,
    },
    $transaction: txFn,
  };
}

// ---------------------------------------------------------------------------
// verifyEmail
// ---------------------------------------------------------------------------

describe("VerificationService.verifyEmail — happy path", () => {
  it("returns { verified: true } for a valid token", async () => {
    const db = makeDb();
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    const result = await svc.verifyEmail(RAW_TOKEN);

    expect(result).toEqual({ verified: true });
  });

  it("looks up token by SHA-256 hash, not raw value", async () => {
    const db = makeDb();
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    await svc.verifyEmail(RAW_TOKEN);

    expect(db.oneTimeToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tokenHash: TOKEN_HASH }),
      }),
    );
  });

  it("runs the activation in a transaction", async () => {
    const db = makeDb();
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    await svc.verifyEmail(RAW_TOKEN);

    expect(db.$transaction).toHaveBeenCalledOnce();
  });
});

describe("VerificationService.verifyEmail — token rejection", () => {
  it("throws INVALID_OR_EXPIRED_TOKEN when token not found", async () => {
    const db = makeDb({ tokenRecord: null });
    const svc = createVerificationService({ db, mailer: new InMemoryMailer() });

    await expect(svc.verifyEmail(RAW_TOKEN)).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  it("throws INVALID_OR_EXPIRED_TOKEN for expired token", async () => {
    const db = makeDb({ tokenRecord: makeValidToken({ expiresAt: pastDate() }) });
    const svc = createVerificationService({ db, mailer: new InMemoryMailer() });

    await expect(svc.verifyEmail(RAW_TOKEN)).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });

  it("throws INVALID_OR_EXPIRED_TOKEN for consumed token when user is not verified (concurrent attack)", async () => {
    const db = makeDb({
      tokenRecord: makeValidToken({ consumedAt: new Date() }),
      userRecord: makeUser({ emailVerifiedAt: null }), // user somehow still unverified
    });
    const svc = createVerificationService({ db, mailer: new InMemoryMailer() });

    await expect(svc.verifyEmail(RAW_TOKEN)).rejects.toMatchObject({
      code: "INVALID_OR_EXPIRED_TOKEN",
    });
  });
});

describe("VerificationService.verifyEmail — idempotency", () => {
  it("returns { verified: true } for consumed token when user is already verified", async () => {
    const db = makeDb({
      tokenRecord: makeValidToken({ consumedAt: new Date() }),
      userRecord: makeUser({ emailVerifiedAt: new Date(), status: "active" }),
    });
    const svc = createVerificationService({ db, mailer: new InMemoryMailer() });

    const result = await svc.verifyEmail(RAW_TOKEN);

    expect(result).toEqual({ verified: true });
    // No transaction for a re-verify.
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resendVerification
// ---------------------------------------------------------------------------

describe("VerificationService.resendVerification — unknown email", () => {
  it("returns silently when account does not exist", async () => {
    const db = makeDb({ userRecord: null });
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    await expect(svc.resendVerification("nobody@example.com")).resolves.toBeUndefined();
    expect(mailer.verificationEmails).toHaveLength(0);
    expect(mailer.registrationAttemptNotices).toHaveLength(0);
  });
});

describe("VerificationService.resendVerification — unverified account", () => {
  it("issues a new token and sends verification email", async () => {
    const db = makeDb({ userRecord: makeUser() });
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    await svc.resendVerification("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.oneTimeToken.updateMany).toHaveBeenCalled(); // invalidate old tokens
    expect(db.oneTimeToken.create).toHaveBeenCalled(); // issue new token
    expect(mailer.verificationEmails).toHaveLength(1);
    expect(mailer.verificationEmails[0]!.to).toBe("alice@example.com");
  });
});

describe("VerificationService.resendVerification — already-verified account", () => {
  it("sends a security notice and does NOT issue a token", async () => {
    const db = makeDb({
      userRecord: makeUser({ emailVerifiedAt: new Date(), status: "active" }),
    });
    const mailer = new InMemoryMailer();
    const svc = createVerificationService({ db, mailer });

    await svc.resendVerification("alice@example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mailer.registrationAttemptNotices).toHaveLength(1);
    expect(mailer.registrationAttemptNotices[0]!.to).toBe("alice@example.com");
    expect(mailer.verificationEmails).toHaveLength(0);
    expect(db.oneTimeToken.create).not.toHaveBeenCalled();
  });
});
