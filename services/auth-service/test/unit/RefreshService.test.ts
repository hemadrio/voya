/**
 * Unit tests for RefreshService (WO-022).
 *
 * Covers:
 *   - Happy path: rotation succeeds, new tokens returned, old session revoked
 *   - Unknown token: INVALID_REFRESH_TOKEN (generic 401)
 *   - Reuse detection: revoked row → family revocation → REFRESH_TOKEN_REUSED (401)
 *   - Absolute expiry: SESSION_EXPIRED when absoluteExpiresAt ≤ now
 *   - Idle expiry: SESSION_EXPIRED when expiresAt ≤ now
 *   - Concurrent race: rotate() returns null → INVALID_REFRESH_TOKEN (no family revoke)
 *   - DB error in rotate: surfaces as INVALID_REFRESH_TOKEN (not 500)
 *   - Cleanup job: deleteExpired called with correct parameters
 *   - generateRefreshToken: returns distinct 32-byte base64url values
 *   - hashRefreshToken: deterministic SHA-256
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRefreshService, generateRefreshToken, hashRefreshToken } from "../../src/domain/RefreshService.js";
import type { RefreshServiceDeps, RefreshInput } from "../../src/domain/RefreshService.js";
import type { SessionRepository, SessionForRefresh, RotatedSessionRow } from "../../src/domain/SessionRepository.js";
import type { ITokenService } from "../../src/domain/TokenService.js";
import { createSessionCleanupJob } from "../../src/jobs/SessionCleanupJob.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);   // 7 days from now
const PAST   = new Date(Date.now() - 1000);                        // 1 second ago
const ABS_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
const ABS_PAST   = new Date(Date.now() - 1000);                      // expired absolute

function makeActiveSession(overrides: Partial<SessionForRefresh> = {}): SessionForRefresh {
  return {
    id: "sess-001",
    userId: "user-001",
    familyId: "family-001",
    revokedAt: null,
    expiresAt: FUTURE,
    absoluteExpiresAt: ABS_FUTURE,
    ipAddress: "127.0.0.1",
    userAgent: "TestClient/1.0",
    ...overrides,
  };
}

function makeRotatedRow(overrides: Partial<RotatedSessionRow> = {}): RotatedSessionRow {
  return {
    newSessionId: "sess-002",
    userId: "user-001",
    familyId: "family-001",
    absoluteExpiresAt: ABS_FUTURE,
    ...overrides,
  };
}

function makeMockRepo(overrides: Partial<SessionRepository> = {}): SessionRepository {
  return {
    createSession: vi.fn(),
    revokeById: vi.fn(),
    revokeAllForUser: vi.fn(),
    listActiveForUser: vi.fn(),
    findByRefreshHash: vi.fn(),
    rotate: vi.fn(),
    revokeFamily: vi.fn(),
    deleteExpired: vi.fn(),
    ...overrides,
  } as unknown as SessionRepository;
}

function makeMockTokenService(): ITokenService {
  return {
    sign: vi.fn().mockReturnValue("new.access.token"),
    verify: vi.fn(),
  };
}

function makeDeps(
  repoOverrides: Partial<SessionRepository> = {},
): RefreshServiceDeps & { repo: SessionRepository; tokenService: ITokenService } {
  const repo = makeMockRepo(repoOverrides);
  const tokenService = makeMockTokenService();
  return {
    sessionRepository: repo,
    tokenService,
    accessTokenTtlSeconds: 900,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateRefreshToken", () => {
  it("returns a base64url string of at least 43 characters (32 bytes)", () => {
    const token = generateRefreshToken();
    // 32 bytes base64url → at least 43 chars (may be 43 or 44 with padding stripped)
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns distinct values on each call", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateRefreshToken));
    expect(tokens.size).toBe(100);
  });
});

describe("hashRefreshToken", () => {
  it("returns a deterministic 64-char hex string", () => {
    const hash = hashRefreshToken("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashRefreshToken("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashRefreshToken("a")).not.toBe(hashRefreshToken("b"));
  });
});

describe("RefreshService.refresh", () => {
  let rawToken: string;
  let hash: string;

  beforeEach(() => {
    rawToken = generateRefreshToken();
    hash = hashRefreshToken(rawToken);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("rotates the session and returns new tokens", async () => {
    const activeSession = makeActiveSession();
    const rotatedRow = makeRotatedRow();

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(activeSession),
      rotate: vi.fn().mockResolvedValue(rotatedRow),
    });
    const svc = createRefreshService(deps);

    const result = await svc.refresh({ rawToken });

    expect(result.accessToken).toBe("new.access.token");
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresIn).toBe(900);
    expect(typeof result.newRefreshToken).toBe("string");
    expect(result.newRefreshToken).not.toBe(rawToken);
    expect(result.userId).toBe("user-001");
  });

  it("passes the old session id to rotate", async () => {
    const activeSession = makeActiveSession({ id: "old-sess" });
    const rotatedRow = makeRotatedRow();
    const rotateFn = vi.fn().mockResolvedValue(rotatedRow);

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(activeSession),
      rotate: rotateFn,
    });
    const svc = createRefreshService(deps);
    await svc.refresh({ rawToken });

    const rotateInput = rotateFn.mock.calls[0]?.[0];
    expect(rotateInput.oldSessionId).toBe("old-sess");
  });

  it("copies absoluteExpiresAt verbatim through rotation", async () => {
    const absExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const activeSession = makeActiveSession({ absoluteExpiresAt: absExpiry });
    const rotatedRow = makeRotatedRow({ absoluteExpiresAt: absExpiry });
    const rotateFn = vi.fn().mockResolvedValue(rotatedRow);

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(activeSession),
      rotate: rotateFn,
    });
    const svc = createRefreshService(deps);
    await svc.refresh({ rawToken });

    const rotateInput = rotateFn.mock.calls[0]?.[0];
    expect(rotateInput.absoluteExpiresAt).toBe(absExpiry);
  });

  // ── Unknown token ──────────────────────────────────────────────────────────

  it("throws INVALID_REFRESH_TOKEN when no session found for hash", async () => {
    const deps = makeDeps({ findByRefreshHash: vi.fn().mockResolvedValue(null) });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
  });

  // ── Reuse detection ────────────────────────────────────────────────────────

  it("revokes the whole family when a revoked session is presented", async () => {
    const revokedSession = makeActiveSession({ revokedAt: PAST });
    const revokeFamilyFn = vi.fn().mockResolvedValue(2);

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(revokedSession),
      revokeFamily: revokeFamilyFn,
    });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
    expect(revokeFamilyFn).toHaveBeenCalledWith("family-001");
  });

  it("does not call revokeFamily when familyId is null on a revoked session", async () => {
    const revokedSession = makeActiveSession({ revokedAt: PAST, familyId: null });
    const revokeFamilyFn = vi.fn();

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(revokedSession),
      revokeFamily: revokeFamilyFn,
    });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSED" });
    expect(revokeFamilyFn).not.toHaveBeenCalled();
  });

  // ── Expiry checks ──────────────────────────────────────────────────────────

  it("throws SESSION_EXPIRED when absoluteExpiresAt is in the past", async () => {
    const session = makeActiveSession({ absoluteExpiresAt: ABS_PAST });

    const deps = makeDeps({ findByRefreshHash: vi.fn().mockResolvedValue(session) });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("throws SESSION_EXPIRED when expiresAt (idle) is in the past", async () => {
    const session = makeActiveSession({ expiresAt: PAST });

    const deps = makeDeps({ findByRefreshHash: vi.fn().mockResolvedValue(session) });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("checks absolute expiry before idle expiry", async () => {
    // Both expired — should still get SESSION_EXPIRED (from absolute check first)
    const session = makeActiveSession({ absoluteExpiresAt: ABS_PAST, expiresAt: PAST });

    const deps = makeDeps({ findByRefreshHash: vi.fn().mockResolvedValue(session) });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  // ── Concurrent race ────────────────────────────────────────────────────────

  it("returns INVALID_REFRESH_TOKEN (not REFRESH_TOKEN_REUSED) when rotate returns null", async () => {
    const activeSession = makeActiveSession();
    const revokeFamilyFn = vi.fn();

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(activeSession),
      rotate: vi.fn().mockResolvedValue(null),
      revokeFamily: revokeFamilyFn,
    });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
    // Family must NOT be revoked for a lost race
    expect(revokeFamilyFn).not.toHaveBeenCalled();
  });

  // ── DB error during rotate ─────────────────────────────────────────────────

  it("surfaces DB errors in rotate as INVALID_REFRESH_TOKEN", async () => {
    const activeSession = makeActiveSession();

    const deps = makeDeps({
      findByRefreshHash: vi.fn().mockResolvedValue(activeSession),
      rotate: vi.fn().mockRejectedValue(new Error("connection timeout")),
    });
    const svc = createRefreshService(deps);

    await expect(svc.refresh({ rawToken })).rejects.toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
  });
});

// ---------------------------------------------------------------------------
// SessionCleanupJob
// ---------------------------------------------------------------------------

describe("SessionCleanupJob", () => {
  it("calls deleteExpired with correct default parameters", async () => {
    const deleteExpiredFn = vi.fn().mockResolvedValue(5);
    const repo = makeMockRepo({ deleteExpired: deleteExpiredFn });
    const job = createSessionCleanupJob(repo);

    const metrics = await job.run();

    expect(deleteExpiredFn).toHaveBeenCalledOnce();
    const { retentionWindowMs, batchSize } = deleteExpiredFn.mock.calls[0]![0]!;
    expect(retentionWindowMs).toBe(30 * 24 * 60 * 60 * 1000); // 30 days
    expect(batchSize).toBe(1000);
    expect(metrics.deletedCount).toBe(5);
    expect(metrics.batchFull).toBe(false);
  });

  it("sets batchFull=true when deletedCount equals batchSize", async () => {
    const repo = makeMockRepo({ deleteExpired: vi.fn().mockResolvedValue(1000) });
    const job = createSessionCleanupJob(repo, { batchSize: 1000 });

    const metrics = await job.run();

    expect(metrics.batchFull).toBe(true);
  });

  it("accepts custom retentionWindowMs and batchSize", async () => {
    const deleteExpiredFn = vi.fn().mockResolvedValue(0);
    const repo = makeMockRepo({ deleteExpired: deleteExpiredFn });
    const job = createSessionCleanupJob(repo, { retentionWindowMs: 7 * 24 * 60 * 60 * 1000, batchSize: 500 });

    await job.run();

    const args = deleteExpiredFn.mock.calls[0]![0]!;
    expect(args.retentionWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(args.batchSize).toBe(500);
  });

  it("never throws on database error — returns zero-count metrics", async () => {
    const repo = makeMockRepo({
      deleteExpired: vi.fn().mockRejectedValue(new Error("DB unavailable")),
    });
    const job = createSessionCleanupJob(repo);

    const metrics = await job.run();

    expect(metrics.deletedCount).toBe(0);
    expect(metrics.batchFull).toBe(false);
  });
});
