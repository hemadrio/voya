/**
 * Unit tests for LoginService.
 *
 * Covers every branch of the login pipeline:
 *   - Happy path returns LoginResponse shape
 *   - Unknown email → INVALID_CREDENTIALS (timing equalization still runs)
 *   - Wrong password → INVALID_CREDENTIALS (and records failed attempt)
 *   - Locked credential → INVALID_CREDENTIALS (no hash work)
 *   - Unverified email → EMAIL_NOT_VERIFIED
 *   - Suspended account → ACCOUNT_DISABLED
 *   - Deleted account → ACCOUNT_DISABLED
 *   - Session created with correct userId and token
 *   - Counters reset after success
 *   - Correct expiresIn returned
 */
import { describe, it, expect, vi } from "vitest";
import { createLoginService, type LoginServiceDeps } from "../../src/domain/LoginService.js";
import type { UserRepository, UserEntity } from "../../src/domain/UserRepository.js";
import type { CredentialRepository, CredentialWithSecret } from "../../src/domain/CredentialRepository.js";
import type { ICredentialService, VerifyResult, LockStatus } from "../../src/domain/CredentialService.js";
import type { SessionRepository, CreatedSessionRow } from "../../src/domain/SessionRepository.js";
import type { ITokenService, TokenClaims } from "../../src/domain/TokenService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_USER: UserEntity = {
  id: "user-001",
  email: "alice@example.com",
  emailVerifiedAt: new Date("2024-01-01"),
  displayName: "Alice",
  status: "active",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const CREDENTIAL: CredentialWithSecret = {
  id: "cred-001",
  userId: "user-001",
  type: "password",
  secretHash: "$scrypt$n=16384,r=8,p=1,kl=64$deadbeef$cafebabe",
  hashAlgorithm: "scrypt",
  failedAttemptCount: 0,
  lockedUntil: null,
  lastUsedAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const CREATED_SESSION: CreatedSessionRow = {
  id: "session-001",
  token: "jti-abc",
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
};

const MOCK_TOKEN = "header.payload.signature";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeUserRepo(user: UserEntity | null = ACTIVE_USER): UserRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(async () => user),
    updateStatus: vi.fn(),
  };
}

function makeCredentialRepo(cred: CredentialWithSecret | null = CREDENTIAL): CredentialRepository {
  return {
    create: vi.fn(),
    findByUserId: vi.fn(),
    findWithSecretByUserId: vi.fn(async () => cred),
  };
}

function makeCredentialService(overrides: Partial<ICredentialService> = {}): ICredentialService {
  return {
    hashPassword: vi.fn(async () => ({ hash: "hashed", algorithm: "scrypt" })),
    verifyPassword: vi.fn(async (): Promise<VerifyResult> => ({ valid: true, needsRehash: false })),
    validatePasswordPolicy: vi.fn(() => ({ valid: true, violations: [] })),
    recordFailedAttempt: vi.fn(async () => ({
      locked: false,
      failedAttemptCount: 1,
      lockedUntil: null,
      retryAfterSeconds: 0,
    })),
    resetFailedAttempts: vi.fn(async () => {}),
    isLocked: vi.fn(async (): Promise<LockStatus> => ({ locked: false, retryAfterSeconds: 0 })),
    ...overrides,
  };
}

function makeSessionRepo(): SessionRepository {
  return {
    createSession: vi.fn(async () => CREATED_SESSION),
    revokeById: vi.fn(async () => true),
    revokeAllForUser: vi.fn(async () => 0),
    listActiveForUser: vi.fn(async () => []),
  };
}

function makeTokenService(): ITokenService {
  return {
    sign: vi.fn(() => MOCK_TOKEN),
    verify: vi.fn((): TokenClaims => ({
      sub: "user-001",
      sid: "session-001",
      iss: "https://auth.test",
      aud: "https://api.test",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: "jti-abc",
      roles: ["user"],
    })),
  };
}

function makeDeps(overrides: Partial<LoginServiceDeps> = {}): LoginServiceDeps {
  return {
    userRepository: makeUserRepo(),
    credentialRepository: makeCredentialRepo(),
    credentialService: makeCredentialService(),
    sessionRepository: makeSessionRepo(),
    tokenService: makeTokenService(),
    accessTokenTtlSeconds: 600,
    ...overrides,
  };
}

const LOGIN_INPUT = {
  email: "alice@example.com",
  password: "Password1!",
  ipAddress: "127.0.0.1",
  userAgent: "vitest",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("LoginService — happy path", () => {
  it("returns accessToken, tokenType Bearer, expiresIn, and user profile", async () => {
    const svc = createLoginService(makeDeps());
    const result = await svc.login(LOGIN_INPUT);

    expect(result.accessToken).toBe(MOCK_TOKEN);
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresIn).toBe(600);
    expect(result.user.id).toBe("user-001");
    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.emailVerified).toBe(true);
  });

  it("defaults roles to ['user'] when no getRoles injected", async () => {
    const svc = createLoginService(makeDeps());
    const result = await svc.login(LOGIN_INPUT);

    expect(result.user.roles).toEqual(["user"]);
  });

  it("uses getRoles when injected", async () => {
    const deps = makeDeps({ getRoles: vi.fn(async () => ["user", "admin"]) });
    const svc = createLoginService(deps);
    const result = await svc.login(LOGIN_INPUT);

    expect(result.user.roles).toEqual(["user", "admin"]);
  });

  it("creates a session with the correct userId", async () => {
    const sessionRepo = makeSessionRepo();
    const deps = makeDeps({ sessionRepository: sessionRepo });
    const svc = createLoginService(deps);
    await svc.login(LOGIN_INPUT);

    expect(sessionRepo.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-001" }),
    );
  });

  it("passes ipAddress and userAgent to createSession", async () => {
    const sessionRepo = makeSessionRepo();
    const deps = makeDeps({ sessionRepository: sessionRepo });
    const svc = createLoginService(deps);
    await svc.login(LOGIN_INPUT);

    expect(sessionRepo.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "127.0.0.1", userAgent: "vitest" }),
    );
  });

  it("resets failed attempt counter after success", async () => {
    const credSvc = makeCredentialService();
    const deps = makeDeps({ credentialService: credSvc });
    const svc = createLoginService(deps);
    await svc.login(LOGIN_INPUT);

    expect(credSvc.resetFailedAttempts).toHaveBeenCalledWith("cred-001");
  });
});

// ---------------------------------------------------------------------------
// Unknown email
// ---------------------------------------------------------------------------

describe("LoginService — unknown email", () => {
  it("throws INVALID_CREDENTIALS when user not found", async () => {
    const deps = makeDeps({ userRepository: makeUserRepo(null) });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("still calls verifyPassword for timing equalization when user not found", async () => {
    const credSvc = makeCredentialService();
    const deps = makeDeps({
      userRepository: makeUserRepo(null),
      credentialRepository: makeCredentialRepo(null),
      credentialService: credSvc,
    });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toBeDefined();
    expect(credSvc.verifyPassword).toHaveBeenCalledWith(LOGIN_INPUT.password, null);
  });
});

// ---------------------------------------------------------------------------
// Wrong password
// ---------------------------------------------------------------------------

describe("LoginService — wrong password", () => {
  it("throws INVALID_CREDENTIALS when password does not match", async () => {
    const credSvc = makeCredentialService({
      verifyPassword: vi.fn(async (): Promise<VerifyResult> => ({ valid: false, needsRehash: false })),
    });
    const deps = makeDeps({ credentialService: credSvc });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("records a failed attempt when password is wrong", async () => {
    const credSvc = makeCredentialService({
      verifyPassword: vi.fn(async (): Promise<VerifyResult> => ({ valid: false, needsRehash: false })),
    });
    const deps = makeDeps({ credentialService: credSvc });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toBeDefined();
    expect(credSvc.recordFailedAttempt).toHaveBeenCalledWith("cred-001");
  });
});

// ---------------------------------------------------------------------------
// Lockout
// ---------------------------------------------------------------------------

describe("LoginService — locked credential", () => {
  it("throws INVALID_CREDENTIALS (not ACCOUNT_TEMPORARILY_LOCKED) when credential is locked", async () => {
    const credSvc = makeCredentialService({
      isLocked: vi.fn(async (): Promise<LockStatus> => ({ locked: true, retryAfterSeconds: 300 })),
    });
    const deps = makeDeps({ credentialService: credSvc });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("does not call verifyPassword when credential is locked (skip expensive hash)", async () => {
    const credSvc = makeCredentialService({
      isLocked: vi.fn(async (): Promise<LockStatus> => ({ locked: true, retryAfterSeconds: 300 })),
    });
    const deps = makeDeps({ credentialService: credSvc });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toBeDefined();
    expect(credSvc.verifyPassword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Email not verified
// ---------------------------------------------------------------------------

describe("LoginService — email not verified", () => {
  it("throws EMAIL_NOT_VERIFIED when emailVerifiedAt is null", async () => {
    const unverifiedUser: UserEntity = { ...ACTIVE_USER, emailVerifiedAt: null };
    const deps = makeDeps({ userRepository: makeUserRepo(unverifiedUser) });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });
});

// ---------------------------------------------------------------------------
// Account disabled
// ---------------------------------------------------------------------------

describe("LoginService — account status checks", () => {
  it("throws ACCOUNT_DISABLED for suspended user", async () => {
    const suspendedUser: UserEntity = { ...ACTIVE_USER, status: "suspended" };
    const deps = makeDeps({ userRepository: makeUserRepo(suspendedUser) });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  it("throws ACCOUNT_DISABLED for deleted user", async () => {
    const deletedUser: UserEntity = { ...ACTIVE_USER, status: "deleted" };
    const deps = makeDeps({ userRepository: makeUserRepo(deletedUser) });
    const svc = createLoginService(deps);

    await expect(svc.login(LOGIN_INPUT)).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });
});

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

describe("LoginService — email normalization", () => {
  it("normalizes email before lookup", async () => {
    const userRepo = makeUserRepo();
    const deps = makeDeps({ userRepository: userRepo });
    const svc = createLoginService(deps);
    await svc.login({ ...LOGIN_INPUT, email: "  ALICE@EXAMPLE.COM  " });

    expect(userRepo.findByEmail).toHaveBeenCalledWith("alice@example.com");
  });
});
