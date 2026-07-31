/**
 * Characterization tests: session lifecycle and revocation.
 *
 * Covers:
 *   - logout revokes the specific session and invalidates the cache
 *   - logoutAll revokes all sessions for a user and returns the count
 *   - listSessions marks the current session
 *   - deleteSession: own session is revoked; another user's session returns
 *     SESSION_NOT_FOUND (no row leaked — cross-account ownership check)
 *   - Cache invalidator is called on every revocation path
 *   - Idempotent logout: calling logout on an already-revoked session does not throw
 *
 * All collaborators are injected fakes — no PrismaClient, no Redis.
 */

import { describe, it, expect, vi } from "vitest";
import { createSessionService } from "../SessionService.js";
import type { SessionRepository } from "../SessionRepository.js";
import type { SessionCacheInvalidator } from "../SessionService.js";

// ---------------------------------------------------------------------------
// Fake builders
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<SessionRepository> = {}): SessionRepository {
  return {
    revokeById: vi.fn(async (_sessionId: string, _userId: string) => true),
    revokeAllForUser: vi.fn(async (_userId: string) => 3),
    listActiveForUser: vi.fn(async (_userId: string) => [
      {
        id: "sess-001",
        createdAt: new Date("2026-01-15T08:00:00Z"),
        lastSeenAt: new Date("2026-01-15T11:55:00Z"),
        ipAddress: "10.0.0.1",
        userAgent: "TravelApp/2.0",
      },
      {
        id: "sess-002",
        createdAt: new Date("2026-01-14T10:00:00Z"),
        lastSeenAt: null,
        ipAddress: null,
        userAgent: null,
      },
    ]),
    ...overrides,
  };
}

function makeInvalidator(): SessionCacheInvalidator & {
  sessionCalls: string[];
  userCalls: string[];
} {
  const sessionCalls: string[] = [];
  const userCalls: string[] = [];
  return {
    sessionCalls,
    userCalls,
    invalidateSession: vi.fn(async (sid: string) => {
      sessionCalls.push(sid);
    }),
    invalidateUser: vi.fn(async (userId: string) => {
      userCalls.push(userId);
    }),
  };
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe("SessionService.logout", () => {
  it("revokes the session by id and user, calls cache invalidation", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.logout({ sid: "sess-001", userId: "user-alice" });

    expect(repo.revokeById).toHaveBeenCalledWith("sess-001", "user-alice");
    expect(cache.invalidateSession).toHaveBeenCalledWith("sess-001");
  });

  it("is idempotent — does not throw when session is already revoked", async () => {
    const repo = makeRepo({ revokeById: vi.fn(async () => false) });
    const svc = createSessionService({ sessionRepository: repo });

    await expect(
      svc.logout({ sid: "already-gone", userId: "user-alice" }),
    ).resolves.toBeUndefined();
  });

  it("does not call invalidateUser on single-session logout", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.logout({ sid: "sess-001", userId: "user-alice" });

    expect(cache.invalidateUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logoutAll
// ---------------------------------------------------------------------------

describe("SessionService.logoutAll", () => {
  it("revokes all sessions and returns the revoked count", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    const result = await svc.logoutAll({ userId: "user-alice" });

    expect(result.revokedCount).toBe(3);
    expect(repo.revokeAllForUser).toHaveBeenCalledWith("user-alice");
  });

  it("calls invalidateUser (not invalidateSession) on logoutAll", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.logoutAll({ userId: "user-alice" });

    expect(cache.invalidateUser).toHaveBeenCalledWith("user-alice");
    expect(cache.invalidateSession).not.toHaveBeenCalled();
  });

  it("returns revokedCount=0 when no active sessions exist", async () => {
    const repo = makeRepo({ revokeAllForUser: vi.fn(async () => 0) });
    const svc = createSessionService({ sessionRepository: repo });

    const result = await svc.logoutAll({ userId: "user-nobody" });

    expect(result.revokedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("SessionService.listSessions", () => {
  it("returns sessions with current flag set correctly", async () => {
    const repo = makeRepo();
    const svc = createSessionService({ sessionRepository: repo });

    const { sessions } = await svc.listSessions({ userId: "user-alice", currentSid: "sess-001" });

    expect(sessions).toHaveLength(2);
    const current = sessions.find((s) => s.id === "sess-001");
    const other = sessions.find((s) => s.id === "sess-002");
    expect(current?.current).toBe(true);
    expect(other?.current).toBe(false);
  });

  it("never exposes the refresh token hash in session listings", async () => {
    const repo = makeRepo();
    const svc = createSessionService({ sessionRepository: repo });

    const { sessions } = await svc.listSessions({ userId: "user-alice", currentSid: "sess-001" });

    const serialised = JSON.stringify(sessions);
    expect(serialised).not.toContain("refreshToken");
    expect(serialised).not.toContain("token_hash");
    expect(serialised).not.toContain("hash");
  });
});

// ---------------------------------------------------------------------------
// deleteSession — cross-account ownership check
// ---------------------------------------------------------------------------

describe("SessionService.deleteSession", () => {
  it("revokes session when it belongs to the user", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await expect(
      svc.deleteSession({ sessionId: "sess-001", userId: "user-alice", currentSid: "sess-002" }),
    ).resolves.toBeUndefined();

    expect(repo.revokeById).toHaveBeenCalledWith("sess-001", "user-alice");
    expect(cache.invalidateSession).toHaveBeenCalledWith("sess-001");
  });

  it("throws SESSION_NOT_FOUND when session does not belong to user (cross-account)", async () => {
    // revokeById returns false — session not found for this user
    const repo = makeRepo({ revokeById: vi.fn(async () => false) });
    const svc = createSessionService({ sessionRepository: repo });

    let errorCode: string | undefined;
    try {
      await svc.deleteSession({
        sessionId: "sess-belonging-to-other-user",
        userId: "user-alice",
        currentSid: "sess-alice-current",
      });
    } catch (err) {
      errorCode = (err as Record<string, unknown>)["code"] as string;
    }

    // Must return SESSION_NOT_FOUND — never leaks whether the session belongs
    // to another user or simply doesn't exist
    expect(errorCode).toBe("SESSION_NOT_FOUND");
  });

  it("does not disclose the target session's owner on cross-account attempt", async () => {
    const repo = makeRepo({ revokeById: vi.fn(async () => false) });
    const svc = createSessionService({ sessionRepository: repo });

    let errorMessage = "";
    try {
      await svc.deleteSession({
        sessionId: "sess-belonging-to-bob",
        userId: "user-alice",
        currentSid: "sess-alice",
      });
    } catch (err) {
      errorMessage = (err as Error).message;
    }

    // Message must not reveal the session owner or whether it exists elsewhere
    expect(errorMessage).not.toContain("bob");
    expect(errorMessage).not.toContain("owner");
  });

  it("calls cache invalidation after successful delete", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.deleteSession({ sessionId: "sess-001", userId: "user-alice", currentSid: "sess-002" });

    expect(cache.invalidateSession).toHaveBeenCalledWith("sess-001");
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation contract
// ---------------------------------------------------------------------------

describe("SessionService — cache invalidation contract", () => {
  it("no invalidation call is skipped on any revocation path", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    // logout → per-session invalidation
    await svc.logout({ sid: "s1", userId: "u1" });
    expect(cache.invalidateSession).toHaveBeenCalledTimes(1);

    // logoutAll → per-user invalidation
    await svc.logoutAll({ userId: "u1" });
    expect(cache.invalidateUser).toHaveBeenCalledTimes(1);

    // deleteSession → per-session invalidation
    await svc.deleteSession({ sessionId: "s2", userId: "u1", currentSid: "s1" });
    expect(cache.invalidateSession).toHaveBeenCalledTimes(2);
  });
});
