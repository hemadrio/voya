/**
 * Unit tests for SessionService.
 *
 * Tests revocation (single session and all-user), listing, ownership
 * filtering (session not owned → 404), and idempotent logout (already revoked
 * returns 204 without error).
 */
import { describe, it, expect, vi } from "vitest";
import { createSessionService } from "../../src/domain/SessionService.js";
import type { SessionRepository } from "../../src/domain/SessionRepository.js";
import type { SessionCacheInvalidator } from "../../src/domain/SessionService.js";

function makeRepo(overrides: Partial<SessionRepository> = {}): SessionRepository {
  return {
    revokeById: vi.fn(async () => true),
    revokeAllForUser: vi.fn(async () => 3),
    listActiveForUser: vi.fn(async () => [
      {
        id: "session-1",
        createdAt: new Date("2024-01-01"),
        lastSeenAt: new Date("2024-01-02"),
        ipAddress: "1.2.3.4",
        userAgent: "TestBrowser/1.0",
      },
      {
        id: "session-2",
        createdAt: new Date("2024-01-03"),
        lastSeenAt: null,
        ipAddress: null,
        userAgent: null,
      },
    ]),
    ...overrides,
  };
}

function makeInvalidator(): SessionCacheInvalidator {
  return {
    invalidateSession: vi.fn(async () => {}),
    invalidateUser: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe("SessionService.logout", () => {
  it("revokes the session and calls cache invalidation", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.logout({ sid: "session-1", userId: "user-1" });

    expect(repo.revokeById).toHaveBeenCalledWith("session-1", "user-1");
    expect(cache.invalidateSession).toHaveBeenCalledWith("session-1");
  });

  it("is idempotent — does not throw if the session was already revoked", async () => {
    const repo = makeRepo({ revokeById: vi.fn(async () => false) });
    const svc = createSessionService({ sessionRepository: repo });

    await expect(svc.logout({ sid: "already-gone", userId: "user-1" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// logoutAll
// ---------------------------------------------------------------------------

describe("SessionService.logoutAll", () => {
  it("revokes all sessions and returns the count", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    const result = await svc.logoutAll({ userId: "user-1" });

    expect(result.revokedCount).toBe(3);
    expect(repo.revokeAllForUser).toHaveBeenCalledWith("user-1");
    expect(cache.invalidateUser).toHaveBeenCalledWith("user-1");
  });

  it("returns 0 when user has no active sessions", async () => {
    const repo = makeRepo({ revokeAllForUser: vi.fn(async () => 0) });
    const svc = createSessionService({ sessionRepository: repo });

    const result = await svc.logoutAll({ userId: "user-2" });
    expect(result.revokedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("SessionService.listSessions", () => {
  it("returns sessions with current flag derived from currentSid", async () => {
    const svc = createSessionService({ sessionRepository: makeRepo() });

    const result = await svc.listSessions({ userId: "user-1", currentSid: "session-1" });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({ id: "session-1", current: true });
    expect(result.sessions[1]).toMatchObject({ id: "session-2", current: false });
  });

  it("never includes refresh_token_hash in session list", async () => {
    const repo = makeRepo({
      listActiveForUser: vi.fn(async () => [
        {
          id: "s1",
          createdAt: new Date(),
          lastSeenAt: null,
          ipAddress: null,
          userAgent: null,
          // refreshTokenHash deliberately NOT included in the returned type
        },
      ]),
    });
    const svc = createSessionService({ sessionRepository: repo });

    const result = await svc.listSessions({ userId: "u1", currentSid: "s1" });

    for (const session of result.sessions) {
      expect(Object.keys(session)).not.toContain("refreshTokenHash");
      expect(Object.keys(session)).not.toContain("refresh_token_hash");
    }
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe("SessionService.deleteSession", () => {
  it("revokes the session and calls cache invalidation", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.deleteSession({ sessionId: "session-2", userId: "user-1", currentSid: "session-1" });

    expect(repo.revokeById).toHaveBeenCalledWith("session-2", "user-1");
    expect(cache.invalidateSession).toHaveBeenCalledWith("session-2");
  });

  it("throws SESSION_NOT_FOUND (404) when session does not belong to the caller", async () => {
    const repo = makeRepo({ revokeById: vi.fn(async () => false) });
    const svc = createSessionService({ sessionRepository: repo });

    await expect(
      svc.deleteSession({ sessionId: "other-users-session", userId: "user-1", currentSid: "session-1" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("behaves like logout when the caller deletes their own current session", async () => {
    const repo = makeRepo();
    const cache = makeInvalidator();
    const svc = createSessionService({ sessionRepository: repo, cacheInvalidator: cache });

    await svc.deleteSession({ sessionId: "session-1", userId: "user-1", currentSid: "session-1" });

    expect(repo.revokeById).toHaveBeenCalledWith("session-1", "user-1");
  });
});
