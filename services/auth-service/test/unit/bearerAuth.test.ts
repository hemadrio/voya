/**
 * Unit tests for WO-023: Bearer-auth middleware, guards, and session cache.
 *
 * Covers:
 *   - Authorization header parsing (missing, empty, wrong scheme, extra whitespace, multi-part)
 *   - JWT verification failures (invalid, expired, missing sid)
 *   - Session revoked / expired → 401 SESSION_REVOKED
 *   - User disabled → 403 ACCOUNT_DISABLED
 *   - Happy path → principal attached to request
 *   - Cache hit: zero DB calls
 *   - Cache miss: single DB call (findByIdWithUserStatus JOIN), result cached
 *   - Cache invalidation
 *   - Cache TTL expiry
 *   - requireRoles: pass, fail, unauthenticated, zero-roles config error
 *   - requirePermissions: pass, fail, unauthenticated, zero-permissions config error
 *   - optionalAuth: no header → anonymous, invalid token → 401, valid → principal
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAuthorizationHeader,
  createBearerAuthMiddleware,
  createOptionalAuthMiddleware,
  type BearerAuthDeps,
} from "../../src/middleware/bearerAuth.js";
import { requireRoles, requirePermissions } from "../../src/middleware/guards.js";
import { createSessionCache } from "../../src/middleware/sessionCache.js";
import type { SessionRepository, SessionWithUserStatus } from "../../src/domain/SessionRepository.js";
import type { ITokenService, TokenClaims } from "../../src/domain/TokenService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CLAIMS: TokenClaims = {
  sub: "user-001",
  sid: "sess-001",
  jti: "jti-001",
  iss: "auth-service",
  aud: "travel-api",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  roles: ["user"],
};

const ACTIVE_ROW: SessionWithUserStatus = {
  id: "sess-001",
  userId: "user-001",
  revokedAt: null,
  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  userStatus: "active",
};

function makeTokenService(overrides: Partial<ITokenService> = {}): ITokenService {
  return {
    sign: vi.fn().mockReturnValue("token"),
    verify: vi.fn().mockReturnValue(VALID_CLAIMS),
    ...overrides,
  };
}

function makeSessionRepo(row: SessionWithUserStatus | null = ACTIVE_ROW): SessionRepository {
  return {
    createSession: vi.fn(),
    revokeById: vi.fn(),
    revokeAllForUser: vi.fn(),
    listActiveForUser: vi.fn(),
    findById: vi.fn(),
    findByIdWithUserStatus: vi.fn().mockResolvedValue(row),
    findByRefreshHash: vi.fn(),
    rotate: vi.fn(),
    revokeFamily: vi.fn(),
    deleteExpired: vi.fn(),
  } as unknown as SessionRepository;
}

function makeDeps(overrides: Partial<BearerAuthDeps> = {}): BearerAuthDeps {
  return {
    tokenService: makeTokenService(),
    sessionRepository: makeSessionRepo(),
    sessionCache: createSessionCache({ ttlMs: 5_000 }),
    ...overrides,
  };
}

function makeReqRes(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : ({} as Record<string, string>),
    correlationId: "corr-001",
    principal: undefined as unknown,
  };
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
    set(h: string, v: string) { this._headers[h] = v; return this; },
    get headersSent() { return this._status !== 0; },
  };
  const next = vi.fn();
  return { req, res, next };
}

// ---------------------------------------------------------------------------
// parseAuthorizationHeader
// ---------------------------------------------------------------------------

describe("parseAuthorizationHeader", () => {
  it("returns null for undefined", () => {
    expect(parseAuthorizationHeader(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAuthorizationHeader("")).toBeNull();
  });

  it("returns null when only scheme present (no token)", () => {
    expect(parseAuthorizationHeader("Bearer")).toBeNull();
  });

  it("returns null for wrong scheme", () => {
    expect(parseAuthorizationHeader("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("accepts Bearer case-insensitively (lower)", () => {
    expect(parseAuthorizationHeader("bearer mytoken")).toEqual({ token: "mytoken" });
  });

  it("accepts Bearer case-insensitively (upper)", () => {
    expect(parseAuthorizationHeader("BEARER mytoken")).toEqual({ token: "mytoken" });
  });

  it("returns null when credential contains spaces (multi-part token)", () => {
    expect(parseAuthorizationHeader("Bearer tok en")).toBeNull();
  });

  it("returns token for valid Bearer header", () => {
    expect(parseAuthorizationHeader("Bearer abc.def.ghi")).toEqual({ token: "abc.def.ghi" });
  });

  it("uses first element when given an array", () => {
    expect(parseAuthorizationHeader(["Bearer first", "Bearer second"])).toEqual({ token: "first" });
  });
});

// ---------------------------------------------------------------------------
// createBearerAuthMiddleware — error paths
// ---------------------------------------------------------------------------

describe("createBearerAuthMiddleware — error paths", () => {
  it("returns 401 UNAUTHENTICATED + WWW-Authenticate for missing header", async () => {
    const mw = createBearerAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes();
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    expect(res._headers["WWW-Authenticate"]).toBeTruthy();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED for malformed header (no scheme)", async () => {
    const mw = createBearerAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes("notvalid");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("returns 401 INVALID_TOKEN when JWT verification throws", async () => {
    const deps = makeDeps({
      tokenService: makeTokenService({
        verify: vi.fn().mockImplementation(() => { throw new Error("expired"); }),
      }),
    });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer bad.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("INVALID_TOKEN");
    expect(res._headers["WWW-Authenticate"]).toBeTruthy();
  });

  it("returns 401 INVALID_TOKEN when sid claim is missing", async () => {
    const claimsNoSid = { ...VALID_CLAIMS, sid: "" };
    const deps = makeDeps({
      tokenService: makeTokenService({ verify: vi.fn().mockReturnValue(claimsNoSid) }),
    });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer token.without.sid");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 SESSION_REVOKED when session has revokedAt set", async () => {
    const revokedRow: SessionWithUserStatus = { ...ACTIVE_ROW, revokedAt: new Date(Date.now() - 1000) };
    const deps = makeDeps({ sessionRepository: makeSessionRepo(revokedRow) });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("SESSION_REVOKED");
  });

  it("returns 401 SESSION_REVOKED when session expiresAt is in the past", async () => {
    const expiredRow: SessionWithUserStatus = { ...ACTIVE_ROW, expiresAt: new Date(Date.now() - 1000) };
    const deps = makeDeps({ sessionRepository: makeSessionRepo(expiredRow) });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("SESSION_REVOKED");
  });

  it("returns 401 SESSION_REVOKED when session is not found", async () => {
    const deps = makeDeps({ sessionRepository: makeSessionRepo(null) });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("SESSION_REVOKED");
  });

  it("returns 403 ACCOUNT_DISABLED for suspended user", async () => {
    const suspendedRow: SessionWithUserStatus = { ...ACTIVE_ROW, userStatus: "suspended" };
    const deps = makeDeps({ sessionRepository: makeSessionRepo(suspendedRow) });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(403);
    expect((res._body as { error: { code: string } }).error.code).toBe("ACCOUNT_DISABLED");
  });

  it("returns 403 ACCOUNT_DISABLED for deleted user", async () => {
    const deletedRow: SessionWithUserStatus = { ...ACTIVE_ROW, userStatus: "deleted" };
    const deps = makeDeps({ sessionRepository: makeSessionRepo(deletedRow) });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(403);
    expect((res._body as { error: { code: string } }).error.code).toBe("ACCOUNT_DISABLED");
  });

  it("calls next() with error on unexpected DB failure", async () => {
    const repo = makeSessionRepo();
    (repo.findByIdWithUserStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const deps = makeDeps({ sessionRepository: repo });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// createBearerAuthMiddleware — happy path
// ---------------------------------------------------------------------------

describe("createBearerAuthMiddleware — happy path", () => {
  it("attaches typed principal on success and calls next()", async () => {
    const mw = createBearerAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error
    const p = (req as { principal?: { userId: string; sessionId: string; tokenId: string; roles: string[]; permissions: string[] } }).principal;
    expect(p).toBeDefined();
    expect(p!.userId).toBe("user-001");
    expect(p!.sessionId).toBe("sess-001");
    expect(p!.tokenId).toBe("jti-001");
    expect(p!.roles).toEqual(["user"]);
    expect(Array.isArray(p!.permissions)).toBe(true);
  });

  it("resolves permissions when resolvePermissions is provided", async () => {
    const deps = makeDeps({
      resolvePermissions: vi.fn().mockResolvedValue(["booking:read", "booking:write"]),
    });
    const mw = createBearerAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    const p = (req as { principal?: { permissions: string[] } }).principal;
    expect(p!.permissions).toEqual(["booking:read", "booking:write"]);
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe("createBearerAuthMiddleware — cache", () => {
  it("makes zero DB calls on cache hit (valid entry)", async () => {
    const repo = makeSessionRepo();
    const cache = createSessionCache({ ttlMs: 60_000 });
    cache.set("sess-001", { userId: "user-001", valid: true, roles: ["user"], permissions: [] });
    const mw = createBearerAuthMiddleware(makeDeps({ sessionRepository: repo, sessionCache: cache }));
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(repo.findByIdWithUserStatus).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("makes exactly one DB call on cache miss, then caches result", async () => {
    const repo = makeSessionRepo();
    const deps = makeDeps({ sessionRepository: repo });
    const mw = createBearerAuthMiddleware(deps);

    // First request — cache miss.
    const { req: r1, res: res1, next: n1 } = makeReqRes("Bearer valid.token");
    await mw(r1 as never, res1 as never, n1);
    expect(repo.findByIdWithUserStatus).toHaveBeenCalledOnce();
    expect(n1).toHaveBeenCalledOnce();

    // Second request — should hit cache, no additional DB call.
    const { req: r2, res: res2, next: n2 } = makeReqRes("Bearer valid.token");
    await mw(r2 as never, res2 as never, n2);
    expect(repo.findByIdWithUserStatus).toHaveBeenCalledOnce(); // still only once
    expect(n2).toHaveBeenCalledOnce();
  });

  it("returns SESSION_REVOKED from cache when entry is invalid", async () => {
    const cache = createSessionCache({ ttlMs: 60_000 });
    cache.set("sess-001", { userId: "user-001", valid: false, roles: [], permissions: [] });
    const mw = createBearerAuthMiddleware(makeDeps({ sessionCache: cache }));
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect((res._body as { error: { code: string } }).error.code).toBe("SESSION_REVOKED");
  });
});

// ---------------------------------------------------------------------------
// SessionCache unit tests
// ---------------------------------------------------------------------------

describe("SessionCache", () => {
  it("returns undefined for an unknown key", () => {
    const cache = createSessionCache();
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("returns undefined for expired entry", () => {
    let fakeNow = 0;
    const cache = createSessionCache({ ttlMs: 1_000, now: () => fakeNow });
    cache.set("s1", { userId: "u1", valid: true, roles: [], permissions: [] });
    fakeNow = 500;
    expect(cache.get("s1")).toBeDefined();
    fakeNow = 1_001; // TTL elapsed
    expect(cache.get("s1")).toBeUndefined();
  });

  it("invalidate() removes entry immediately", () => {
    const cache = createSessionCache({ ttlMs: 60_000 });
    cache.set("s1", { userId: "u1", valid: true, roles: [], permissions: [] });
    expect(cache.get("s1")).toBeDefined();
    cache.invalidate("s1");
    expect(cache.get("s1")).toBeUndefined();
  });

  it("size() reflects current count", () => {
    const cache = createSessionCache({ ttlMs: 60_000 });
    expect(cache.size()).toBe(0);
    cache.set("s1", { userId: "u1", valid: true, roles: [], permissions: [] });
    cache.set("s2", { userId: "u2", valid: true, roles: [], permissions: [] });
    expect(cache.size()).toBe(2);
    cache.invalidate("s1");
    expect(cache.size()).toBe(1);
  });

  it("purgeExpired() removes stale entries", () => {
    let fakeNow = 0;
    const cache = createSessionCache({ ttlMs: 1_000, now: () => fakeNow });
    cache.set("s1", { userId: "u1", valid: true, roles: [], permissions: [] });
    cache.set("s2", { userId: "u2", valid: true, roles: [], permissions: [] });
    fakeNow = 2_000;
    cache.purgeExpired();
    expect(cache.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requireRoles
// ---------------------------------------------------------------------------

describe("requireRoles", () => {
  it("throws at definition time when called with zero roles", () => {
    expect(() => requireRoles()).toThrow(/configuration error/i);
  });

  it("passes (calls next with no arg) when principal has a required role", () => {
    const guard = requireRoles("admin");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: ["user", "admin"], permissions: [],
    };
    guard(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("returns 403 INSUFFICIENT_PERMISSIONS when no required role present", () => {
    const guard = requireRoles("admin");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: ["user"], permissions: [],
    };
    guard(req as never, res as never, next);
    expect(res._status).toBe(403);
    const body = res._body as { error: { code: string; required: string[] } };
    expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    expect(body.error.required).toContain("admin");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when no principal is set", () => {
    const guard = requireRoles("admin");
    const { req, res, next } = makeReqRes();
    guard(req as never, res as never, next);
    expect(res._status).toBe(401);
  });

  it("user with zero roles fails all requireRoles checks", () => {
    const guard = requireRoles("user");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: [], permissions: [],
    };
    guard(req as never, res as never, next);
    expect(res._status).toBe(403);
  });

  it("passes when user has one of multiple required roles", () => {
    const guard = requireRoles("admin", "support");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: ["support"], permissions: [],
    };
    guard(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// requirePermissions
// ---------------------------------------------------------------------------

describe("requirePermissions", () => {
  it("throws at definition time when called with zero permissions", () => {
    expect(() => requirePermissions()).toThrow(/configuration error/i);
  });

  it("passes when principal holds all required permissions", () => {
    const guard = requirePermissions("booking:read", "booking:write");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: ["user"],
      permissions: ["booking:read", "booking:write", "booking:cancel"],
    };
    guard(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("returns 403 INSUFFICIENT_PERMISSIONS when a permission is missing", () => {
    const guard = requirePermissions("booking:write");
    const { req, res, next } = makeReqRes();
    (req as never as { principal: object }).principal = {
      userId: "u1", sessionId: "s1", tokenId: "j1", roles: ["user"], permissions: ["booking:read"],
    };
    guard(req as never, res as never, next);
    expect(res._status).toBe(403);
    expect((res._body as { error: { code: string; required: string[] } }).error.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("returns 401 when no principal is set", () => {
    const guard = requirePermissions("booking:read");
    const { req, res, next } = makeReqRes();
    guard(req as never, res as never, next);
    expect(res._status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// createOptionalAuthMiddleware
// ---------------------------------------------------------------------------

describe("createOptionalAuthMiddleware", () => {
  it("continues anonymously (no principal) when Authorization header is absent", async () => {
    const mw = createOptionalAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes();
    await mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect((req as { principal?: unknown }).principal).toBeUndefined();
  });

  it("continues anonymously when Authorization header is blank", async () => {
    const mw = createOptionalAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes("   ");
    await mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as { principal?: unknown }).principal).toBeUndefined();
  });

  it("attaches principal when a valid token is present", async () => {
    const mw = createOptionalAuthMiddleware(makeDeps());
    const { req, res, next } = makeReqRes("Bearer valid.token");
    await mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as { principal?: { userId: string } }).principal?.userId).toBe("user-001");
  });

  it("returns 401 INVALID_TOKEN for present-but-invalid token (no silent downgrade)", async () => {
    const deps = makeDeps({
      tokenService: makeTokenService({
        verify: vi.fn().mockImplementation(() => { throw new Error("invalid"); }),
      }),
    });
    const mw = createOptionalAuthMiddleware(deps);
    const { req, res, next } = makeReqRes("Bearer bad.token");
    await mw(req as never, res as never, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
