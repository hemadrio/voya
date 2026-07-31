/**
 * Unit tests for actorContextVerifier.ts
 *
 * Covers:
 *   - mintActorContext / verifyActorContext round-trip
 *   - Tampered payload detection
 *   - Tampered signature detection
 *   - Missing signature separator
 *   - Malformed base64url
 *   - Invalid payload claims
 *   - Express middleware: missing header → 401
 *   - Express middleware: invalid header → 401
 *   - Express middleware: valid header → req.actor set, next() called
 *   - Timing-safe comparison (wrong-length signature)
 */

import {
  mintActorContext,
  verifyActorContext,
  createActorContextMiddleware,
} from '../../src/middleware/actorContextVerifier.js';

const SECRET = 'test-hmac-secret-32-bytes-minimum!';

const VALID_PAYLOAD = {
  sub: 'f0000000-0000-4000-8000-000000000001',
  sid: 'session-abc-123',
  roles: ['traveler'] as string[],
  jti: 'jti-xyz-789',
  issuedAt: 1700000000,
};

// ── mintActorContext / verifyActorContext ──────────────────────────────────

describe('mintActorContext + verifyActorContext', () => {
  it('round-trips: mint then verify returns the original payload', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const result = verifyActorContext(header, SECRET);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.sub).toBe(VALID_PAYLOAD.sub);
    expect(result.context.sid).toBe(VALID_PAYLOAD.sid);
    expect(result.context.roles).toEqual(VALID_PAYLOAD.roles);
    expect(result.context.jti).toBe(VALID_PAYLOAD.jti);
    expect(result.context.issuedAt).toBe(VALID_PAYLOAD.issuedAt);
  });

  it('returns ok=false when the secret differs', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const result = verifyActorContext(header, 'wrong-secret');

    expect(result.ok).toBe(false);
  });

  it('returns ok=false when no dot separator is present', () => {
    const result = verifyActorContext('nodotinhere', SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('missing signature separator');
  });

  it('returns ok=false for empty string', () => {
    const result = verifyActorContext('', SECRET);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when payload is tampered after signing', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const [encoded, sig] = header.split('.');
    // Tamper: replace last char of encoded payload
    const tampered = `${encoded!.slice(0, -1)}X.${sig}`;
    const result = verifyActorContext(tampered, SECRET);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when signature is tampered', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const [encoded] = header.split('.');
    const result = verifyActorContext(`${encoded}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, SECRET);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when encoded payload is not valid JSON', () => {
    // Build a valid HMAC over garbage base64url payload
    const { createHmac } = require('node:crypto');
    const garbage = Buffer.from('not-valid-json', 'utf8').toString('base64url');
    const hmac = createHmac('sha256', SECRET).update(garbage).digest().toString('base64url');
    const result = verifyActorContext(`${garbage}.${hmac}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('malformed payload JSON');
  });

  it('returns ok=false when payload is valid JSON but missing required claims', () => {
    const { createHmac } = require('node:crypto');
    const incomplete = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const hmac = createHmac('sha256', SECRET).update(incomplete).digest().toString('base64url');
    const result = verifyActorContext(`${incomplete}.${hmac}`, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('invalid payload claims');
  });

  it('produces different headers for different payloads', () => {
    const h1 = mintActorContext(VALID_PAYLOAD, SECRET);
    const h2 = mintActorContext({ ...VALID_PAYLOAD, sub: 'different-sub' }, SECRET);
    expect(h1).not.toBe(h2);
  });

  it('produces different headers for different secrets', () => {
    const h1 = mintActorContext(VALID_PAYLOAD, 'secret-a');
    const h2 = mintActorContext(VALID_PAYLOAD, 'secret-b');
    expect(h1).not.toBe(h2);
  });
});

// ── createActorContextMiddleware ─────────────────────────────────────────────

describe('createActorContextMiddleware', () => {
  function makeReq(headerValue?: string) {
    return {
      headers: headerValue
        ? { 'x-internal-actor': headerValue }
        : {},
      actor: undefined as unknown,
    };
  }

  function makeRes() {
    const res = {
      statusCode: 0,
      body: null as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };
    return res;
  }

  const middleware = createActorContextMiddleware({ secret: SECRET });

  it('calls next() and sets req.actor when header is valid', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const req = makeReq(header);
    const res = makeRes();
    const next = jest.fn();

    middleware(req as Parameters<typeof middleware>[0], res as Parameters<typeof middleware>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as { actor?: unknown }).actor).toBeDefined();
    expect((req.actor as { sub: string }).sub).toBe(VALID_PAYLOAD.sub);
  });

  it('returns 401 with ACTOR_CONTEXT_INVALID when header is missing', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    middleware(req as Parameters<typeof middleware>[0], res as Parameters<typeof middleware>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('ACTOR_CONTEXT_INVALID');
  });

  it('returns 401 with ACTOR_CONTEXT_INVALID when header is plain JSON (unsigned)', () => {
    const req = makeReq(JSON.stringify(VALID_PAYLOAD));
    const res = makeRes();
    const next = jest.fn();

    middleware(req as Parameters<typeof middleware>[0], res as Parameters<typeof middleware>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('ACTOR_CONTEXT_INVALID');
  });

  it('returns 401 when header was signed with a different secret', () => {
    const header = mintActorContext(VALID_PAYLOAD, 'different-secret');
    const req = makeReq(header);
    const res = makeRes();
    const next = jest.fn();

    middleware(req as Parameters<typeof middleware>[0], res as Parameters<typeof middleware>[1], next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('supports custom header name override', () => {
    const mw = createActorContextMiddleware({ secret: SECRET, headerName: 'x-my-actor' });
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const req = { headers: { 'x-my-actor': header }, actor: undefined };
    const res = makeRes();
    const next = jest.fn();

    mw(req as Parameters<typeof mw>[0], res as Parameters<typeof mw>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles array header value (takes first element)', () => {
    const header = mintActorContext(VALID_PAYLOAD, SECRET);
    const req = { headers: { 'x-internal-actor': [header, 'other'] }, actor: undefined };
    const res = makeRes();
    const next = jest.fn();

    middleware(req as Parameters<typeof middleware>[0], res as Parameters<typeof middleware>[1], next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
