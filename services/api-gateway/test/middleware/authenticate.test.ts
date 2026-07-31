/**
 * Unit tests for the RS256 JWT authenticate middleware.
 *
 * Tests run fully offline — no Redis, no AWS, no network.
 * Key material is generated at module load from testKeys.ts.
 *
 * Covers:
 *   - Missing Authorization header → 401 UNAUTHENTICATED
 *   - Valid token with current key → passes through
 *   - Valid token with previous key (rotation overlap) → passes through
 *   - Token signed with an untrusted key → 401 UNAUTHENTICATED
 *   - Expired token → 401 UNAUTHENTICATED
 *   - Tampered payload → 401 UNAUTHENTICATED
 *   - Denylisted jti → 401 TOKEN_REVOKED
 *   - Redis unavailable (conservative policy) → 401 TOKEN_REVOKED
 *   - x-internal-actor header is set with actor context after success
 *   - No JWT value ever appears in logged output
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAuthenticateMiddleware,
  revokeJti,
  type JtiDenylist,
} from '../../src/middleware/authenticate.js';
import type { KeyProvider } from '@travel/auth';
import {
  TEST_KEY_CURRENT,
  TEST_KEY_PREVIOUS,
  TEST_KEY_OTHER,
  mintTestJwt,
  mintExpiredJwt,
} from '../fixtures/testKeys.js';

// ---------------------------------------------------------------------------
// Fake KeyProvider factory
// ---------------------------------------------------------------------------

function makeKeyProvider(
  current = TEST_KEY_CURRENT,
  previous: typeof TEST_KEY_PREVIOUS | null = null,
): KeyProvider {
  return {
    getVerificationKeys: vi.fn().mockResolvedValue([
      { publicKeyPem: current.publicKeyPem, version: current.version },
      ...(previous
        ? [{ publicKeyPem: previous.publicKeyPem, version: previous.version }]
        : []),
    ]),
    getSigningKey: vi.fn(),
    invalidateCache: vi.fn(),
  } as unknown as KeyProvider;
}

// ---------------------------------------------------------------------------
// Fake denylist factories
// ---------------------------------------------------------------------------

function makeDenylist(deniedJtis: Set<string> = new Set()): JtiDenylist {
  return {
    exists: vi.fn(async (jti: string) => (deniedJtis.has(jti) ? 1 : 0)),
    set: vi.fn(async () => 'OK'),
  };
}

function makeFailingDenylist(): JtiDenylist {
  return {
    exists: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
    set: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
  };
}

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

function makeReq(authHeader?: string, extraHeaders?: Record<string, string>) {
  return {
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
      ...extraHeaders,
    } as Record<string, string | undefined>,
    correlationId: 'test-ref-001',
  };
}

function makeRes() {
  let statusCode = 200;
  let body: unknown;
  return {
    get statusCode() { return statusCode; },
    get body() { return body; },
    status(code: number) { statusCode = code; return this; },
    json(b: unknown) { body = b; return this; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authenticate — missing authorization header', () => {
  it('returns 401 UNAUTHENTICATED when Authorization header is absent', async () => {
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeDenylist(),
    });
    const req = makeReq(undefined);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 when Authorization header does not start with "Bearer "', async () => {
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeDenylist(),
    });
    const req = makeReq('Basic dXNlcjpwYXNz');
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticate — valid token', () => {
  it('calls next() and sets x-internal-actor for a valid token with current key', async () => {
    const token = mintTestJwt(TEST_KEY_CURRENT);
    const next = vi.fn();
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(TEST_KEY_CURRENT, null),
      denylist: makeDenylist(),
    });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(typeof req.headers['x-internal-actor']).toBe('string');
    const actor = JSON.parse(req.headers['x-internal-actor'] as string);
    expect(actor.sub).toBe('usr_01J0TESTUSER');
    expect(Array.isArray(actor.roles)).toBe(true);
  });

  it('accepts a valid token signed with the previous key (rotation overlap)', async () => {
    const token = mintTestJwt(TEST_KEY_PREVIOUS);
    const next = vi.fn();
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(TEST_KEY_CURRENT, TEST_KEY_PREVIOUS),
      denylist: makeDenylist(),
    });
    const req = makeReq(`Bearer ${token}`);
    await middleware(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authenticate — invalid token', () => {
  it('returns 401 for a token signed with an untrusted key', async () => {
    const token = mintTestJwt(TEST_KEY_OTHER);
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(TEST_KEY_CURRENT, null),
      denylist: makeDenylist(),
    });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const token = mintExpiredJwt(TEST_KEY_CURRENT);
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(TEST_KEY_CURRENT, null),
      denylist: makeDenylist(),
    });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a tampered payload', async () => {
    const token = mintTestJwt(TEST_KEY_CURRENT);
    // Tamper: replace payload with a different base64url segment
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', exp: 9999999999, iat: 0, sid: 's', roles: ['traveler'], jti: 'j' }),
    ).toString('base64url');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeDenylist(),
    });
    const req = makeReq(`Bearer ${tampered}`);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticate — jti denylist', () => {
  it('returns 401 TOKEN_REVOKED for a denylisted jti', async () => {
    const token = mintTestJwt(TEST_KEY_CURRENT, { jti: 'revoked-jti-001' });
    const denied = new Set(['revoked-jti-001']);
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeDenylist(denied),
    });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');
  });

  it('returns 401 TOKEN_REVOKED (conservative policy) when Redis is unavailable', async () => {
    const token = mintTestJwt(TEST_KEY_CURRENT);
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeFailingDenylist(),
    });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    await middleware(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('TOKEN_REVOKED');
  });
});

describe('revokeJti', () => {
  it('calls denylist.set with the correct TTL', async () => {
    const denylist = makeDenylist();
    const nowMs = Date.now();
    const expSeconds = Math.floor(nowMs / 1000) + 900;
    await revokeJti(denylist, 'jti-abc', expSeconds, () => nowMs);
    expect(denylist.set).toHaveBeenCalledWith('jti-abc', '1', 'EX', expect.any(Number));
    const ttl = (denylist.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});

describe('authenticate — security invariant: JWT value never logged', () => {
  it('logs error context without the JWT value', async () => {
    const warnSpy = vi.fn();
    const token = mintTestJwt(TEST_KEY_CURRENT, { jti: 'log-test-jti' });
    const denied = new Set(['log-test-jti']);
    const middleware = createAuthenticateMiddleware({
      keyProvider: makeKeyProvider(),
      denylist: makeDenylist(denied),
      logger: { warn: warnSpy, error: vi.fn() },
    });
    const req = makeReq(`Bearer ${token}`);
    await middleware(req, makeRes(), vi.fn());
    const loggedArgs = JSON.stringify(warnSpy.mock.calls);
    expect(loggedArgs).not.toContain(token);
  });
});
