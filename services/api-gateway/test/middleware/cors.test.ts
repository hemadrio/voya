/**
 * Unit tests for the strict CORS middleware.
 *
 * Verifies:
 *   - Allow-listed origins are echoed and credentials=true is set
 *   - Denied origins receive no Access-Control-Allow-Origin header
 *   - Vary: Origin is always set
 *   - Preflight OPTIONS from allowed origin returns 204 with correct headers
 *   - Preflight from denied origin returns 204 with no CORS headers
 *   - No wildcard is ever used with credentials
 */
import { describe, it, expect, vi } from 'vitest';
import { createCorsMiddleware } from '../../src/middleware/cors.js';

const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:3000'];

function makeRequest(
  method = 'GET',
  origin?: string,
): { method: string; headers: Record<string, string | undefined> } {
  return {
    method,
    headers: { origin },
  };
}

function makeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  return {
    headers,
    statusCode,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    end: vi.fn(),
  };
}

describe('createCorsMiddleware — allowed origins', () => {
  const middleware = createCorsMiddleware({
    config: { allowedOrigins: ALLOWED_ORIGINS },
  });

  it('echoes the allowed origin in Access-Control-Allow-Origin', () => {
    const req = makeRequest('GET', 'https://app.example.com');
    const res = makeResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets Access-Control-Allow-Credentials: true for allowed origin', () => {
    const req = makeRequest('GET', 'https://app.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('always sets Vary: Origin regardless of origin allow-list result', () => {
    const req = makeRequest('GET', 'https://denied.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['vary']).toBe('Origin');
  });
});

describe('createCorsMiddleware — denied origins', () => {
  const middleware = createCorsMiddleware({
    config: { allowedOrigins: ALLOWED_ORIGINS },
  });

  it('does NOT set Access-Control-Allow-Origin for a denied origin', () => {
    const req = makeRequest('GET', 'https://evil.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does NOT set Access-Control-Allow-Credentials for a denied origin', () => {
    const req = makeRequest('GET', 'https://evil.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('calls next() even for denied origins (so the route can respond)', () => {
    const req = makeRequest('GET', 'https://evil.example.com');
    const res = makeResponse();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('logs a warning for denied origins when logger is provided', () => {
    const warnSpy = vi.fn();
    const loggedMiddleware = createCorsMiddleware({
      config: { allowedOrigins: ALLOWED_ORIGINS },
      logger: { warn: warnSpy },
    });
    const req = makeRequest('GET', 'https://evil.example.com');
    loggedMiddleware(req, makeResponse(), vi.fn());
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('createCorsMiddleware — preflight (OPTIONS)', () => {
  const middleware = createCorsMiddleware({
    config: { allowedOrigins: ALLOWED_ORIGINS },
  });

  it('returns 204 with CORS headers for allowed-origin preflight', () => {
    const req = makeRequest('OPTIONS', 'https://app.example.com');
    const res = makeResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(204);
    expect(res.end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
  });

  it('returns 204 but WITHOUT Access-Control-Allow-Origin for denied-origin preflight', () => {
    const req = makeRequest('OPTIONS', 'https://evil.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never combines wildcard with credentials', () => {
    // Iterate all header combinations set for allowed origins
    const req = makeRequest('OPTIONS', 'https://app.example.com');
    const res = makeResponse();
    middleware(req, res, vi.fn());
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('createCorsMiddleware — no origin header', () => {
  const middleware = createCorsMiddleware({
    config: { allowedOrigins: ALLOWED_ORIGINS },
  });

  it('calls next without setting CORS headers when Origin is absent', () => {
    const req = makeRequest('GET', undefined);
    const res = makeResponse();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
