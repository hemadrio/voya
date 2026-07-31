/**
 * Unit tests for RegistrationService.
 *
 * Covers: new-user transaction, existing-unverified resend, existing-verified
 * security notice, password-policy rejection, token hashing, enumeration safety.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createRegistrationService } from "../../src/domain/RegistrationService.js";
import { InMemoryMailer } from "../../src/mailer/Mailer.js";
import { REGISTRATION_ACCEPTED_MESSAGE } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

type FakeUser = { id: string; email: string; emailVerifiedAt: Date | null; status: string };

function makeDb(overrides: {
  existingUser?: FakeUser | null;
  createdUserId?: string;
} = {}) {
  const existingUser = overrides.existingUser ?? null;
  const createdUserId = overrides.createdUserId ?? "user-new";

  const txFn = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txProxy));

  const txProxy = {
    user: {
      create: vi.fn(async () => ({
        id: createdUserId,
        email: "alice@example.com",
        emailVerifiedAt: null,
        status: "pending",
      })),
      findUnique: vi.fn(async () => existingUser),
    },
    credential: { create: vi.fn(async () => ({ id: "cred-1" })) },
    role: { findFirst: vi.fn(async () => ({ id: "role-traveler" })) },
    userRole: { create: vi.fn(async () => ({ userId: createdUserId, roleId: "role-traveler" })) },
    oneTimeToken: {
      create: vi.fn(async () => ({ id: "token-1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: txFn,
  };

  return {
    user: {
      findUnique: vi.fn(async () => existingUser),
      create: txProxy.user.create,
    },
    credential: txProxy.credential,
    role: txProxy.role,
    userRole: txProxy.userRole,
    oneTimeToken: {
      create: txProxy.oneTimeToken.create,
      updateMany: txProxy.oneTimeToken.updateMany,
    },
    $transaction: txFn,
    _txProxy: txProxy,
  };
}

const noopHashPassword = vi.fn(async () => ({ hash: "hash-value", algorithm: "scrypt" }));
const alwaysValidPolicy = vi.fn(() => ({ valid: true, violations: [] }));
const alwaysFailPolicy = vi.fn(() => ({
  valid: false,
  violations: [{ rule: "minLength", message: "Too short" }],
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RegistrationService.register — new user (Branch A)", () => {
  let mailer: InMemoryMailer;

  beforeEach(() => {
    mailer = new InMemoryMailer();
    noopHashPassword.mockClear();
    alwaysValidPolicy.mockClear();
  });

  it("returns generic message for new user", async () => {
    const db = makeDb();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    const result = await svc.register({
      email: "alice@example.com",
      password: "Password1!",
      firstName: "Alice",
      lastName: "Smith",
    });

    expect(result.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
  });

  it("calls hashPassword and $transaction for new user", async () => {
    const db = makeDb();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    await svc.register({ email: "alice@example.com", password: "Password1!" });

    expect(noopHashPassword).toHaveBeenCalledOnce();
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("sends verification email after transaction", async () => {
    const db = makeDb();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    await svc.register({ email: "Alice@Example.com", password: "Password1!" });

    // Flush microtasks so the fire-and-forget mailer completes.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mailer.verificationEmails).toHaveLength(1);
    expect(mailer.verificationEmails[0]!.to).toBe("alice@example.com");
    expect(mailer.verificationEmails[0]!.verificationToken).toBeTruthy();
  });

  it("assigns default traveler role in transaction", async () => {
    const db = makeDb();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    await svc.register({ email: "alice@example.com", password: "Password1!" });

    expect(db._txProxy.userRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleId: "role-traveler" }) }),
    );
  });

  it("stores a SHA-256 hash of the token, not the raw token", async () => {
    const db = makeDb();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    await svc.register({ email: "alice@example.com", password: "Password1!" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rawToken = mailer.verificationEmails[0]!.verificationToken;
    // The token create call receives { data: { ... tokenHash: ... } }
    const createCall = db._txProxy.oneTimeToken.create.mock.calls[0] as [
      { data: { tokenHash: string } },
    ];
    const storedHash = createCall[0].data.tokenHash;

    expect(storedHash).toBe(hashToken(rawToken));
    expect(storedHash).not.toBe(rawToken);
  });
});

describe("RegistrationService.register — password policy (422)", () => {
  it("throws POLICY_VIOLATION when policy fails", async () => {
    const db = makeDb();
    const mailer = new InMemoryMailer();
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysFailPolicy,
    });

    const err = await svc.register({ email: "alice@example.com", password: "weak" }).catch((e) => e);

    expect(err).toBeDefined();
    expect((err as { code: string }).code).toBe("POLICY_VIOLATION");
    expect((err as { violations: unknown[] }).violations).toHaveLength(1);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(mailer.verificationEmails).toHaveLength(0);
  });
});

describe("RegistrationService.register — existing unverified (Branch B)", () => {
  it("resends token and returns generic 202 message", async () => {
    const mailer = new InMemoryMailer();
    const db = makeDb({
      existingUser: { id: "u-old", email: "bob@example.com", emailVerifiedAt: null, status: "pending" },
    });
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    const result = await svc.register({ email: "bob@example.com", password: "Password1!" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
    expect(mailer.verificationEmails).toHaveLength(1);
    expect(mailer.registrationAttemptNotices).toHaveLength(0);
  });

  it("invalidates old tokens before issuing new one", async () => {
    const mailer = new InMemoryMailer();
    const db = makeDb({
      existingUser: { id: "u-old", email: "bob@example.com", emailVerifiedAt: null, status: "pending" },
    });
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    await svc.register({ email: "bob@example.com", password: "Password1!" });

    expect(db.oneTimeToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u-old", consumedAt: null }) }),
    );
    expect(db.oneTimeToken.create).toHaveBeenCalled();
  });
});

describe("RegistrationService.register — existing verified (Branch C)", () => {
  it("sends security notice and returns generic 202 message", async () => {
    const mailer = new InMemoryMailer();
    const db = makeDb({
      existingUser: {
        id: "u-verified",
        email: "carol@example.com",
        emailVerifiedAt: new Date(),
        status: "active",
      },
    });
    const svc = createRegistrationService({
      db,
      mailer,
      hashPassword: noopHashPassword,
      validatePasswordPolicy: alwaysValidPolicy,
    });

    const result = await svc.register({ email: "carol@example.com", password: "Password1!" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
    expect(mailer.registrationAttemptNotices).toHaveLength(1);
    expect(mailer.registrationAttemptNotices[0]!.to).toBe("carol@example.com");
    expect(mailer.verificationEmails).toHaveLength(0);
  });
});
