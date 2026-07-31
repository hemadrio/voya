/**
 * Unit tests for authorize.ts
 *
 * Covers:
 *   - requireRole: allows actor with matching role
 *   - requireRole: denies actor with non-matching role (403)
 *   - requireRole: denies missing actor (401)
 *   - requireRole: allows actor with one of multiple accepted roles
 *   - allowGuest: always calls next()
 *   - denyByDefault: always returns 403
 *   - registerRouteGuard / getGuardRegistry: registration round-trip
 *   - assertAllRoutesGuarded: throws on missing guard
 *   - assertAllRoutesGuarded: passes when all routes are registered
 *   - GUEST_ROUTES: contains exactly the four allowed routes
 */

import {
  requireRole,
  allowGuest,
  denyByDefault,
  registerRouteGuard,
  getGuardRegistry,
  assertAllRoutesGuarded,
  GUEST_ROUTES,
  _clearGuardRegistry,
} from '../../src/middleware/authorize.js';

// Helper factories
function makeActor(roles: string[]) {
  return { sub: 'user-abc', sid: 'session-1', roles, jti: 'jti-1', issuedAt: 1700000000 };
}

function makeReq(actor?: ReturnType<typeof makeActor>, correlationId = 'corr-123') {
  return { headers: {}, actor, correlationId };
}

function makeRes() {
  const r = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
  };
  return r;
}

beforeEach(() => {
  _clearGuardRegistry();
});

// ── requireRole ───────────────────────────────────────────────────────────────

describe('requireRole', () => {
  it('calls next() when actor has the required role', () => {
    const actor = makeActor(['traveler']);
    const req = makeReq(actor);
    const res = makeRes();
    const next = jest.fn();

    requireRole('traveler')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0); // no response written
  });

  it('calls next() when actor has one of multiple accepted roles', () => {
    const actor = makeActor(['support_agent']);
    const req = makeReq(actor);
    const res = makeRes();
    const next = jest.fn();

    requireRole('traveler', 'support_agent')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 FORBIDDEN when actor lacks the required role', () => {
    const actor = makeActor(['traveler']);
    const req = makeReq(actor);
    const res = makeRes();
    const next = jest.fn();

    requireRole('support_agent')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('returns 401 UNAUTHENTICATED when no actor is present', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn();

    requireRole('traveler')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 403 when system role tries to access traveler-only route', () => {
    const actor = makeActor(['system']);
    const req = makeReq(actor);
    const res = makeRes();
    const next = jest.fn();

    requireRole('traveler')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('includes correlationId as reference in error response', () => {
    const req = makeReq(undefined, 'trace-ref-999');
    const res = makeRes();
    const next = jest.fn();

    requireRole('traveler')(req as Parameters<ReturnType<typeof requireRole>>[0], res as Parameters<ReturnType<typeof requireRole>>[1], next);

    expect((res.body as { reference: string }).reference).toBe('trace-ref-999');
  });
});

// ── allowGuest ────────────────────────────────────────────────────────────────

describe('allowGuest', () => {
  it('always calls next() regardless of actor presence', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn();

    allowGuest()(req as Parameters<ReturnType<typeof allowGuest>>[0], res as Parameters<ReturnType<typeof allowGuest>>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it('calls next() even when actor is present', () => {
    const actor = makeActor(['traveler']);
    const req = makeReq(actor);
    const res = makeRes();
    const next = jest.fn();

    allowGuest()(req as Parameters<ReturnType<typeof allowGuest>>[0], res as Parameters<ReturnType<typeof allowGuest>>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ── denyByDefault ─────────────────────────────────────────────────────────────

describe('denyByDefault', () => {
  it('always returns 403 FORBIDDEN', () => {
    const req = makeReq(makeActor(['traveler']));
    const res = makeRes();
    const next = jest.fn();

    denyByDefault()(req as Parameters<ReturnType<typeof denyByDefault>>[0], res as Parameters<ReturnType<typeof denyByDefault>>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});

// ── Route guard registry ──────────────────────────────────────────────────────

describe('registerRouteGuard / getGuardRegistry', () => {
  it('registers a route and retrieves it', () => {
    registerRouteGuard('GET', '/bookings/:id', 'requireRole', ['traveler']);
    const registry = getGuardRegistry();
    expect(registry.has('GET:/bookings/:id')).toBe(true);
    expect(registry.get('GET:/bookings/:id')?.type).toBe('requireRole');
  });

  it('is case-insensitive on method', () => {
    registerRouteGuard('post', '/search', 'allowGuest');
    expect(getGuardRegistry().has('POST:/search')).toBe(true);
  });
});

// ── assertAllRoutesGuarded ────────────────────────────────────────────────────

describe('assertAllRoutesGuarded', () => {
  it('does not throw when all routes are registered', () => {
    registerRouteGuard('GET', '/foo', 'requireRole', ['traveler']);
    registerRouteGuard('POST', '/bar', 'allowGuest');

    expect(() =>
      assertAllRoutesGuarded([['GET', '/foo'], ['POST', '/bar']]),
    ).not.toThrow();
  });

  it('throws when a route is not in the registry', () => {
    registerRouteGuard('GET', '/foo', 'requireRole', ['traveler']);

    expect(() =>
      assertAllRoutesGuarded([['GET', '/foo'], ['DELETE', '/unguarded']]),
    ).toThrow('DELETE:/unguarded');
  });

  it('throws listing all missing routes', () => {
    expect(() =>
      assertAllRoutesGuarded([['GET', '/a'], ['POST', '/b']]),
    ).toThrow();
  });
});

// ── GUEST_ROUTES ──────────────────────────────────────────────────────────────

describe('GUEST_ROUTES', () => {
  it('contains exactly four routes', () => {
    expect(GUEST_ROUTES.size).toBe(4);
  });

  it('contains POST /v1/flights/search', () => {
    expect(GUEST_ROUTES.has('POST:/v1/flights/search')).toBe(true);
  });

  it('contains POST /v1/hotels/search', () => {
    expect(GUEST_ROUTES.has('POST:/v1/hotels/search')).toBe(true);
  });

  it('contains POST /v1/cars/search', () => {
    expect(GUEST_ROUTES.has('POST:/v1/cars/search')).toBe(true);
  });

  it('contains POST /v1/chat', () => {
    expect(GUEST_ROUTES.has('POST:/v1/chat')).toBe(true);
  });

  it('does NOT contain any fifth route', () => {
    // Adding a route here requires an explicit test update (documented intent)
    const nonGuestRoutes = [
      'POST:/v1/bookings',
      'GET:/v1/bookings/:id',
      'POST:/v1/auth/login',
      'GET:/v1/users/me',
    ];
    for (const route of nonGuestRoutes) {
      expect(GUEST_ROUTES.has(route)).toBe(false);
    }
  });
});
