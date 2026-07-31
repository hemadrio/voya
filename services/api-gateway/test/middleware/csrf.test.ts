/**
 * Unit tests for the CSRF double-submit middleware.
 *
 * Covers:
 *   - GET / HEAD / OPTIONS pass through without CSRF check
 *   - POST without x-csrf-token header → 403 CSRF_FAILED
 *   - POST with header but no cookie → 403 CSRF_FAILED
 *   - POST with mismatching header and cookie → 403 CSRF_FAILED
 *   - POST with matching header and cookie → next() called
 *   - Webhook route is exempt from CSRF
 *   - Non-allow-listed Origin on state-changing request → 403 CSRF_FAILED
 *   - Sec-Fetch-Site: cross-site → 403 CSRF_FAILED
 */
import { describe, it, expect, vi } from 'vitest';
import { createCsrfMiddleware } from '../../src/middleware/csrf.js';

const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:3000'];

function makeCsrf() {
  return createCsrfMiddleware({
    corsConfig: { allowedOrigins: ALLOWED_ORIGINS },
  });
}

interface ReqOptions {
  method?: string;
  path?: string;
  csrfHeader?: string;
  csrfCookie?: string;
  origin?: string;
  secFetchSite?: string;
}

function makeReq(opts: ReqOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.csrfHeader) headers['x-csrf-token'] = opts.csrfHeader;
  if (opts.csrfCookie) headers['cookie'] = `x-csrf-token=${opts.csrfCookie}; session=abc`;
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.secFetchSite) headers['sec-fetch-site'] = opts.secFetchSite;
  return {
    method: opts.method ?? 'POST',
    path: opts.path ?? '/api/v1/bookings',
    headers,
    correlationId: 'csrf-test-001',
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

describe('CSRF — safe methods bypass CSRF check', () => {
  const csrf = makeCsrf();

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    it(`passes ${method} without any CSRF tokens`, () => {
      const req = makeReq({ method });
      const next = vi.fn();
      csrf(req, makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  }
});

describe('CSRF — webhook route is exempt', () => {
  const csrf = makeCsrf();

  it('allows POST /webhooks/stripe without CSRF tokens', () => {
    const req = makeReq({ method: 'POST', path: '/webhooks/stripe' });
    const next = vi.fn();
    csrf(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('CSRF — missing header', () => {
  const csrf = makeCsrf();

  it('returns 403 CSRF_FAILED when x-csrf-token header is absent', () => {
    const req = makeReq({ csrfCookie: 'token-abc' });
    const res = makeRes();
    csrf(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  });
});

describe('CSRF — missing cookie', () => {
  const csrf = makeCsrf();

  it('returns 403 CSRF_FAILED when x-csrf-token cookie is absent', () => {
    const req = makeReq({ csrfHeader: 'token-abc' });
    const res = makeRes();
    csrf(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  });
});

describe('CSRF — mismatched tokens', () => {
  const csrf = makeCsrf();

  it('returns 403 CSRF_FAILED when header and cookie values differ', () => {
    const req = makeReq({ csrfHeader: 'token-aaa', csrfCookie: 'token-bbb' });
    const res = makeRes();
    csrf(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
  });
});

describe('CSRF — matching tokens', () => {
  const csrf = makeCsrf();

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`calls next() for ${method} with matching CSRF tokens`, () => {
      const token = 'csrf-valid-token-xyz';
      const req = makeReq({ method, csrfHeader: token, csrfCookie: token });
      const next = vi.fn();
      csrf(req, makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  }
});

describe('CSRF — Origin check', () => {
  const csrf = makeCsrf();

  it('returns 403 when Origin is not in the allow-list on a state-changing request', () => {
    const req = makeReq({
      origin: 'https://evil.example.com',
      csrfHeader: 'token-abc',
      csrfCookie: 'token-abc',
    });
    const res = makeRes();
    csrf(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
  });

  it('passes when Origin is allow-listed', () => {
    const token = 'token-xyz';
    const req = makeReq({
      origin: 'https://app.example.com',
      csrfHeader: token,
      csrfCookie: token,
    });
    const next = vi.fn();
    csrf(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('CSRF — Sec-Fetch-Site', () => {
  const csrf = makeCsrf();

  it('returns 403 when Sec-Fetch-Site is cross-site', () => {
    const token = 'token-abc';
    const req = makeReq({
      csrfHeader: token,
      csrfCookie: token,
      secFetchSite: 'cross-site',
    });
    const res = makeRes();
    csrf(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it('passes when Sec-Fetch-Site is same-origin', () => {
    const token = 'token-xyz';
    const req = makeReq({
      csrfHeader: token,
      csrfCookie: token,
      secFetchSite: 'same-origin',
    });
    const next = vi.fn();
    csrf(req, makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
