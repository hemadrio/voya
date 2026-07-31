/**
 * Registration + email-verification integration tests.
 *
 * Exercises the full HTTP stack (Express app → domain services → Prisma → DB)
 * with an InMemoryMailer capturing sent messages.
 *
 * Requires DATABASE_URL in the environment (docker-compose postgres with
 * migrations already applied).  Skipped automatically when DATABASE_URL is
 * unset — suitable to run in CI alongside the database service.
 *
 * Run:
 *   DATABASE_URL=postgres://... vitest run test/integration/registration.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.js";
import { InMemoryMailer } from "../../src/mailer/Mailer.js";
import { createRegistrationService } from "../../src/domain/RegistrationService.js";
import { createVerificationService } from "../../src/domain/VerificationService.js";
import { createCredentialService } from "../../src/domain/CredentialService.js";
import type { CredentialServiceConfig } from "../../src/domain/credentialServiceConfig.js";
import { createInMemoryRateLimiter } from "../../src/middleware/rateLimiter.js";
import { REGISTRATION_ACCEPTED_MESSAGE } from "@travel/contracts";
import type { AuthDomain } from "../../src/routes/auth.js";
import {
  VALID_REGISTER_REQUEST,
  EXPIRED_RAW_TOKEN,
  makeExpiredTokenRecord,
} from "../fixtures/registration-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Faster scrypt params for integration tests (avoids real cost in CI).
const TEST_CREDENTIAL_CONFIG: CredentialServiceConfig = {
  scrypt: { N: 1024, r: 8, p: 1, keyLen: 64 },
  lockout: { threshold: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  policy: { minLength: 8, maxLength: 128 },
  commonPasswordsPath: join(__dirname, "../fixtures/common-passwords.txt"),
};

const DATABASE_URL = process.env["DATABASE_URL"];
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describeWithDb("Registration + Email Verification (integration)", () => {
  let prisma: PrismaClient;
  let mailer: InMemoryMailer;
  let app: ReturnType<typeof createApp>;
  // Track created user IDs so they can be cleaned up between tests.
  const createdUserEmails: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Clean up users created during tests to avoid cross-test pollution.
    if (createdUserEmails.length > 0) {
      await prisma.user.deleteMany({
        where: { email: { in: createdUserEmails } },
      });
      createdUserEmails.length = 0;
    }
    mailer.reset();
  });

  function buildApp() {
    mailer = new InMemoryMailer();

    const credentialService = createCredentialService(TEST_CREDENTIAL_CONFIG, prisma);

    const registrationService = createRegistrationService({
      db: prisma,
      mailer,
      hashPassword: (pw) => credentialService.hashPassword(pw),
      validatePasswordPolicy: (pw, emailLocalPart) =>
        credentialService.validatePasswordPolicy(pw, emailLocalPart),
    });

    const verificationService = createVerificationService({ db: prisma, mailer });

    const domain: AuthDomain = {
      register: (input) => registrationService.register(input as Parameters<typeof registrationService.register>[0]),
      verifyEmail: (params) => verificationService.verifyEmail(params.token),
      resendVerification: (params) => verificationService.resendVerification(params.email),
      // Other domain methods are not exercised in these tests.
      login: () => Promise.reject(new Error("not implemented")),
      refresh: () => Promise.reject(new Error("not implemented")),
      logout: () => Promise.reject(new Error("not implemented")),
      oauthCallback: () => Promise.reject(new Error("not implemented")),
      logoutAll: () => Promise.reject(new Error("not implemented")),
      listSessions: () => Promise.reject(new Error("not implemented")),
      deleteSession: () => Promise.reject(new Error("not implemented")),
      forgotPassword: () => Promise.reject(new Error("not implemented")),
      resetPassword: () => Promise.reject(new Error("not implemented")),
    };

    app = createApp(domain, {
      routerOptions: {
        registerLimiter: createInMemoryRateLimiter({ maxHits: 100, windowSeconds: 1 }),
        resendVerificationLimiter: createInMemoryRateLimiter({ maxHits: 100, windowSeconds: 1 }),
      },
    });

    return app;
  }

  // ---------------------------------------------------------------------------
  // Happy path: register → verify → active
  // ---------------------------------------------------------------------------

  it("register → verify → account becomes active", async () => {
    buildApp();
    const email = `reg-verify-${Date.now()}@example.com`;
    createdUserEmails.push(email);

    // 1. Register
    const regRes = await request(app)
      .post("/auth/register")
      .send({ ...VALID_REGISTER_REQUEST, email });

    expect(regRes.status).toBe(202);
    expect(regRes.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);

    // Allow fire-and-forget mailer to complete.
    await new Promise((r) => setTimeout(r, 10));

    // 2. InMemoryMailer captured exactly one verification email.
    expect(mailer.verificationEmails).toHaveLength(1);
    const rawToken = mailer.verificationEmails[0]!.verificationToken;
    expect(rawToken).toBeTruthy();

    // 3. Verify the email.
    const verifyRes = await request(app)
      .post("/auth/verify-email")
      .send({ token: rawToken });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body).toEqual({ verified: true });

    // 4. Confirm account is now active in the DB.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.status).toBe("active");
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Duplicate email returns identical 202 body
  // ---------------------------------------------------------------------------

  it("duplicate email registration returns byte-identical 202 body (enumeration-safe)", async () => {
    buildApp();
    const email = `dup-${Date.now()}@example.com`;
    createdUserEmails.push(email);

    const payload = { ...VALID_REGISTER_REQUEST, email };

    const [res1, res2] = await Promise.all([
      request(app).post("/auth/register").send(payload),
      request(app).post("/auth/register").send(payload),
    ]);

    // Both must return 202 with the same body shape.
    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);
    expect(res1.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
    expect(res2.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
    // Bodies are identical — no enumeration leak.
    expect(JSON.stringify(res1.body)).toBe(JSON.stringify(res2.body));
  });

  // ---------------------------------------------------------------------------
  // Reused token → 400
  // ---------------------------------------------------------------------------

  it("verifying the same token twice returns 400 on the second call", async () => {
    buildApp();
    const email = `reuse-${Date.now()}@example.com`;
    createdUserEmails.push(email);

    await request(app).post("/auth/register").send({ ...VALID_REGISTER_REQUEST, email });
    await new Promise((r) => setTimeout(r, 10));

    const rawToken = mailer.verificationEmails[0]!.verificationToken;

    // First verify: success.
    const res1 = await request(app).post("/auth/verify-email").send({ token: rawToken });
    expect(res1.status).toBe(200);

    // Second verify with same token: 400 (idempotent success since user is verified).
    const res2 = await request(app).post("/auth/verify-email").send({ token: rawToken });
    // Per idempotency rule: consumed + user verified → 200 (not error).
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ verified: true });
  });

  // ---------------------------------------------------------------------------
  // Expired seeded token → 400
  // ---------------------------------------------------------------------------

  it("expired token returns 400 with stable error code", async () => {
    buildApp();
    const email = `expired-${Date.now()}@example.com`;
    createdUserEmails.push(email);

    // Create a pending user, then manually seed an expired token.
    const user = await prisma.user.create({
      data: { email, status: "pending" },
    });

    await prisma.oneTimeToken.create({
      data: makeExpiredTokenRecord(user.id),
    });

    const res = await request(app)
      .post("/auth/verify-email")
      .send({ token: EXPIRED_RAW_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
  });

  // ---------------------------------------------------------------------------
  // Rate limiting on resend
  // ---------------------------------------------------------------------------

  it("resend-verification with unknown email returns 202 (enumeration-safe)", async () => {
    buildApp();
    const res = await request(app)
      .post("/auth/resend-verification")
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe(REGISTRATION_ACCEPTED_MESSAGE);
    expect(mailer.verificationEmails).toHaveLength(0);
    expect(mailer.registrationAttemptNotices).toHaveLength(0);
  });
});
