/**
 * Unit tests for securityHeaders middleware.
 *
 * Verifies that every required security header is emitted with the correct
 * value, that HSTS is conditional on environment, and that the middleware
 * calls next() so the request chain continues.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSecurityHeaders } from '../../src/middleware/securityHeaders.js';

function makeResponseSpy() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  };
}

describe('createSecurityHeaders', () => {
  it('sets Content-Security-Policy on every response', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    const next = vi.fn();

    middleware({}, res, next);

    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('sets X-Content-Type-Options: nosniff', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Referrer-Policy', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets X-Frame-Options: DENY', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Permissions-Policy locking camera, microphone, and geolocation', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    const policy = res.headers['permissions-policy'] ?? '';
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=()');
  });

  it('sets HSTS with max-age=63072000 and includeSubDomains when emitHsts:true', () => {
    const middleware = createSecurityHeaders({ emitHsts: true });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });

  it('does NOT set HSTS when emitHsts:false', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('calls next() so the request chain continues', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const next = vi.fn();
    middleware({}, makeResponseSpy(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('CSP restricts frame-src to Stripe domains only', () => {
    const middleware = createSecurityHeaders({ emitHsts: false });
    const res = makeResponseSpy();
    middleware({}, res, vi.fn());
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toContain('frame-src https://js.stripe.com https://hooks.stripe.com');
  });
});
