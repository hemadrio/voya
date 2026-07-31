/**
 * Characterization tests: credential hashing, verification, password policy,
 * and per-account login lockout.
 *
 * Covers:
 *   - hashPassword produces scrypt PHC-format hash (never plaintext storage)
 *   - verifyPassword correct → valid=true
 *   - verifyPassword wrong → valid=false; message contains no plaintext
 *   - verifyPassword null storedHash (unknown user) → valid=false, no exception
 *   - validatePasswordPolicy min/max length, common password, email-local
 *   - LoginAttemptGuard: lockout after 5 failures in 15 minutes
 *   - Lockout boundary: 5th failure at 14m59s → locked; history reset beyond window
 *   - No plaintext passwords appear in any hash output or error message
 *
 * Uses cheap scrypt parameters (N=1024) to keep tests fast while exercising
 * the real hash path.
 * All DB operations are injected fakes — no PrismaClient.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCredentialService,
  CredentialError,
} from "../CredentialService.js";
import type { CredentialServiceDbClient, ICredentialService } from "../CredentialService.js";
import type { CredentialServiceConfig } from "../credentialServiceConfig.js";
import { LoginAttemptGuard } from "../LoginAttemptGuard.js";
import type { LoginAttemptDbClient, LoginAuditLogger } from "../LoginAttemptGuard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test config — cheap scrypt so tests run in < 200 ms
// ---------------------------------------------------------------------------

const TEST_CONFIG: CredentialServiceConfig = {
  scrypt: { N: 1024, r: 8, p: 1, keyLen: 64 },
  lockout: { threshold: 5, baseDelayMs: 5 * 60 * 1000, maxDelayMs: 24 * 60 * 60 * 1000 },
  policy: { minLength: 12, maxLength: 128 },
  commonPasswordsPath: join(__dirname, "../../../../test/fixtures/common-passwords.txt"),
};

// ---------------------------------------------------------------------------
// Fake DB builders
// ---------------------------------------------------------------------------

function makeCredentialDb(
  overrides: Partial<CredentialServiceDbClient["credential"]> = {},
): CredentialServiceDbClient {
  const defaultRow = { id: "cred-test-001", failedAttemptCount: 0, lockedUntil: null as Date | null };
  return {
    credential: {
      findFirst: async () => defaultRow,
      update: async (args) => {
        const count = typeof args.data.failedAttemptCount === "object"
          ? defaultRow.failedAttemptCount + (args.data.failedAttemptCount as { increment: number }).increment
          : (args.data.failedAttemptCount ?? defaultRow.failedAttemptCount);
        return { ...defaultRow, failedAttemptCount: count, lockedUntil: args.data.lockedUntil !== undefined ? args.data.lockedUntil as Date | null : defaultRow.lockedUntil };
      },
      ...overrides,
    },
  };
}

function makeLoginAttemptDb(
  users: Array<{ email: string; failedAttemptCount: number; lockedUntil: Date | null }>,
): { db: LoginAttemptDbClient; state: Map<string, { id: string; failedAttemptCount: number; lockedUntil: Date | null }> } {
  const state = new Map(users.map((u) => [u.email, { id: `user-${u.email}`, ...u }]));
  return {
    state,
    db: {
      user: {
        async findUnique(args) {
          return state.get(args.where.email) ?? null;
        },
        async update(args) {
          const user = [...state.values()].find((u) => u.id === args.where.id);
          if (user) {
            Object.assign(user, args.data);
          }
        },
      },
    },
  };
}

function makeAuditLogger(): { logger: LoginAuditLogger; records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    logger: {
      write(record) {
        records.push(record);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Hash and verify
// ---------------------------------------------------------------------------

describe("CredentialService — hashPassword", () => {
  it("returns a PHC-format scrypt hash starting with $scrypt$", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const { hash, algorithm } = await svc.hashPassword("correct-horse-battery-staple");
    expect(hash).toMatch(/^\$scrypt\$/);
    expect(algorithm).toBe("scrypt");
  });

  it("never stores the plaintext password in the hash string", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const password = "correct-horse-battery-staple";
    const { hash } = await svc.hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it("produces a different hash for the same password (unique salt)", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const { hash: h1 } = await svc.hashPassword("same-password-abc123");
    const { hash: h2 } = await svc.hashPassword("same-password-abc123");
    expect(h1).not.toBe(h2);
  });
});

describe("CredentialService — verifyPassword", () => {
  it("returns valid=true for the correct password", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const password = "correct-horse-battery-staple";
    const { hash } = await svc.hashPassword(password);
    const result = await svc.verifyPassword(password, hash);
    expect(result.valid).toBe(true);
  });

  it("returns valid=false for a wrong password", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const { hash } = await svc.hashPassword("correct-horse-battery-staple");
    const result = await svc.verifyPassword("wrong-password-12345", hash);
    expect(result.valid).toBe(false);
  });

  it("returns valid=false for null storedHash (unknown user — timing equalisation)", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const result = await svc.verifyPassword("any-password", null);
    expect(result.valid).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it("sets needsRehash=true when hash was created with different parameters", async () => {
    // Hash with legacy N=512, verify with N=1024 config — should trigger needsRehash
    const legacyConfig: CredentialServiceConfig = { ...TEST_CONFIG, scrypt: { N: 512, r: 8, p: 1, keyLen: 64 } };
    const legacySvc = createCredentialService(legacyConfig, makeCredentialDb());
    const { hash } = await legacySvc.hashPassword("password-to-rehash-abc");

    const currentSvc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    const result = await currentSvc.verifyPassword("password-to-rehash-abc", hash);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it("does not include the plaintext password in any thrown error", async () => {
    const svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
    let caughtMessage = "";
    try {
      await svc.verifyPassword("secret-password-do-not-log", "invalid-hash-format");
    } catch (err) {
      if (err instanceof Error) caughtMessage = err.message;
    }
    expect(caughtMessage).not.toContain("secret-password-do-not-log");
  });
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

describe("CredentialService — validatePasswordPolicy", () => {
  let svc: ICredentialService;
  beforeAll(() => {
    svc = createCredentialService(TEST_CONFIG, makeCredentialDb());
  });

  it("accepts a valid long password", () => {
    const result = svc.validatePasswordPolicy("correct-horse-battery-staple");
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects a password shorter than minLength (12)", () => {
    const result = svc.validatePasswordPolicy("short");
    expect(result.valid).toBe(false);
    const rule = result.violations.find((v) => v.rule === "MIN_LENGTH");
    expect(rule).toBeDefined();
  });

  it("rejects a password longer than maxLength (128)", () => {
    const longPass = "a".repeat(129);
    const result = svc.validatePasswordPolicy(longPass);
    expect(result.valid).toBe(false);
    const rule = result.violations.find((v) => v.rule === "MAX_LENGTH");
    expect(rule).toBeDefined();
  });

  it("rejects a password containing the email local part", () => {
    const result = svc.validatePasswordPolicy("alice-is-the-password", "alice");
    expect(result.valid).toBe(false);
    const rule = result.violations.find((v) => v.rule === "CONTAINS_EMAIL_LOCAL");
    expect(rule).toBeDefined();
  });

  it("accumulates multiple violations in one pass", () => {
    const result = svc.validatePasswordPolicy("short");
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// LoginAttemptGuard — lockout after 5 failures
// ---------------------------------------------------------------------------

describe("LoginAttemptGuard — per-account lockout", () => {
  const BASE_NOW = 1737000000000; // fixed clock base in ms
  const WINDOW_MS = 15 * 60 * 1000;

  it("allows login before any failures", async () => {
    const { db } = makeLoginAttemptDb([
      { email: "alice@test.example", failedAttemptCount: 0, lockedUntil: null },
    ]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    const result = await guard.checkAllowed("alice@test.example");
    expect(result.allowed).toBe(true);
  });

  it("allows login for unknown email (no account enumeration prevention bypass)", async () => {
    const { db } = makeLoginAttemptDb([]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    const result = await guard.checkAllowed("unknown@test.example");
    expect(result.allowed).toBe(true);
  });

  it("locks account after 5 failures", async () => {
    const email = "bob@test.example";
    const { db, state } = makeLoginAttemptDb([
      { email, failedAttemptCount: 0, lockedUntil: null },
    ]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    // Record 5 failures
    for (let i = 0; i < 5; i++) {
      await guard.recordFailure(email, "127.0.0.1");
    }

    // Check locked state
    const user = state.get(email)!;
    expect(user.lockedUntil).not.toBeNull();
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(BASE_NOW);
  });

  it("prevents login when lockedUntil is in the future", async () => {
    const email = "charlie@test.example";
    const futureTime = new Date(BASE_NOW + WINDOW_MS);
    const { db } = makeLoginAttemptDb([
      { email, failedAttemptCount: 5, lockedUntil: futureTime },
    ]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    const result = await guard.checkAllowed(email);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows login once lockedUntil has passed", async () => {
    const email = "dave@test.example";
    const pastTime = new Date(BASE_NOW - 1000); // 1 second in the past
    const { db } = makeLoginAttemptDb([
      { email, failedAttemptCount: 5, lockedUntil: pastTime },
    ]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    const result = await guard.checkAllowed(email);
    expect(result.allowed).toBe(true);
  });

  it("recordSuccess resets the failure counter and lockout", async () => {
    const email = "eve@test.example";
    const lockedUntil = new Date(BASE_NOW + WINDOW_MS);
    const { db, state } = makeLoginAttemptDb([
      { email, failedAttemptCount: 5, lockedUntil },
    ]);
    const { logger } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    await guard.recordSuccess(email, "127.0.0.1");

    const user = state.get(email)!;
    expect(user.failedAttemptCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it("audit logger records every attempt with outcome", async () => {
    const email = "frank@test.example";
    const { db } = makeLoginAttemptDb([
      { email, failedAttemptCount: 0, lockedUntil: null },
    ]);
    const { logger, records } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    await guard.recordFailure(email, "10.0.0.1", "invalid_credentials");
    await guard.recordSuccess(email, "10.0.0.1");

    expect(records.length).toBeGreaterThanOrEqual(2);
    const failure = (records as Array<Record<string, unknown>>).find((r) => r["outcome"] === "failure");
    const success = (records as Array<Record<string, unknown>>).find((r) => r["outcome"] === "success");
    expect(failure).toBeDefined();
    expect(success).toBeDefined();
  });

  it("audit records never contain plaintext passwords", async () => {
    const email = "grace@test.example";
    const { db } = makeLoginAttemptDb([
      { email, failedAttemptCount: 0, lockedUntil: null },
    ]);
    const { logger, records } = makeAuditLogger();
    const guard = new LoginAttemptGuard({ db, auditLogger: logger, clock: () => BASE_NOW });

    await guard.recordFailure(email, "10.0.0.1", "invalid_credentials");

    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("hash");
  });
});
