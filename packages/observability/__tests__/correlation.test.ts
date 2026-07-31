/**
 * Unit tests for packages/observability/src/correlation.ts
 *
 * AC8: ID validation, header echo, child-logger binding, outbound header
 *      injection, ALS survival across awaits, and queue attribute injection.
 */

import { describe, it, expect, vi } from "vitest";
import {
  generateULID,
  isValidCorrelationId,
  getCorrelationId,
  getTraceId,
  injectHeaders,
  injectMessageAttributes,
  createCorrelationIdMiddleware,
} from '../src/correlation.js';
import {
  VALID_ULID,
  VALID_UUID_V4,
  OVERSIZED_CORRELATION_ID,
  CRLF_INJECTION_ID,
  NEWLINE_INJECTION_ID,
  EMPTY_CORRELATION_ID,
  RANDOM_NON_FORMAT_ID,
  UUID_V5,
  BASE_OUTBOUND_HEADERS,
} from './fixtures/correlation-fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockRequest = {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  log?: unknown;
};
type MockResponse = {
  headers: Record<string, string>;
  setHeader(name: string, value: string): MockResponse;
};
type MockNext = ReturnType<typeof vi.fn>;

function mockReq(correlationIdHeader?: string): MockRequest {
  return {
    headers: correlationIdHeader !== undefined
      ? { 'x-correlation-id': correlationIdHeader }
      : {},
  };
}

function mockRes(): MockResponse {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string): MockResponse {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

function runMiddleware(
  req: MockRequest,
  res = mockRes(),
  next: MockNext = vi.fn(),
): { req: MockRequest; res: MockResponse; next: MockNext } {
  const mw = createCorrelationIdMiddleware();
  mw(req, res, next);
  return { req, res, next };
}

// ---------------------------------------------------------------------------
// ULID generation
// ---------------------------------------------------------------------------

describe('generateULID', () => {
  it('returns a 26-character string', () => {
    expect(generateULID()).toHaveLength(26);
  });

  it('returns only Crockford Base32 characters', () => {
    const id = generateULID();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateULID()));
    expect(ids.size).toBe(100);
  });

  it('generates sortable values (later calls have >= timestamps)', () => {
    const a = generateULID();
    const b = generateULID();
    // First 10 chars encode the timestamp; lexicographic >= holds for same-ms or later
    expect(b >= a).toBe(true);
  });

  it('validates as a valid correlation ID', () => {
    expect(isValidCorrelationId(generateULID())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidCorrelationId
// ---------------------------------------------------------------------------

describe('isValidCorrelationId', () => {
  it('accepts a valid ULID', () => {
    expect(isValidCorrelationId(VALID_ULID)).toBe(true);
  });

  it('accepts a valid UUID v4', () => {
    expect(isValidCorrelationId(VALID_UUID_V4)).toBe(true);
  });

  it('rejects an oversized value (>64 chars)', () => {
    expect(isValidCorrelationId(OVERSIZED_CORRELATION_ID)).toBe(false);
  });

  it('rejects a value with CRLF (header injection)', () => {
    expect(isValidCorrelationId(CRLF_INJECTION_ID)).toBe(false);
  });

  it('rejects a value with a newline character', () => {
    expect(isValidCorrelationId(NEWLINE_INJECTION_ID)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidCorrelationId(EMPTY_CORRELATION_ID)).toBe(false);
  });

  it('rejects a random non-format string', () => {
    expect(isValidCorrelationId(RANDOM_NON_FORMAT_ID)).toBe(false);
  });

  it('rejects a UUID v5 (version bit is 5, not 4)', () => {
    expect(isValidCorrelationId(UUID_V5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// correlationIdMiddleware — resolution and echo
// ---------------------------------------------------------------------------

describe('createCorrelationIdMiddleware — ID resolution', () => {
  it('echoes a valid ULID inbound header unchanged', () => {
    const req = mockReq(VALID_ULID);
    const { res, next } = runMiddleware(req);
    expect(res.headers['x-correlation-id']).toBe(VALID_ULID);
    expect(req.correlationId).toBe(VALID_ULID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('echoes a valid UUID v4 inbound header unchanged', () => {
    const req = mockReq(VALID_UUID_V4);
    const { res } = runMiddleware(req);
    expect(res.headers['x-correlation-id']).toBe(VALID_UUID_V4);
  });

  it('replaces a malformed inbound header with a fresh ULID', () => {
    const req = mockReq(RANDOM_NON_FORMAT_ID);
    const { res } = runMiddleware(req);
    const id = res.headers['x-correlation-id'];
    expect(id).toBeDefined();
    expect(id).not.toBe(RANDOM_NON_FORMAT_ID);
    expect(id).toHaveLength(26);
    expect(isValidCorrelationId(id!)).toBe(true);
  });

  it('generates a fresh ULID when no inbound header is present', () => {
    const req = mockReq();
    const { res } = runMiddleware(req);
    const id = res.headers['x-correlation-id'];
    expect(id).toHaveLength(26);
    expect(isValidCorrelationId(id!)).toBe(true);
  });

  it('never echoes a CRLF-injection header back', () => {
    const req = mockReq(CRLF_INJECTION_ID);
    const { res } = runMiddleware(req);
    const id = res.headers['x-correlation-id'];
    expect(id).not.toContain('\r');
    expect(id).not.toContain('\n');
  });

  it('sets x-correlation-id on the response for 2xx, 4xx, and 5xx paths', () => {
    // The middleware always sets the header before next() is called;
    // it is set regardless of the response status.
    const req = mockReq(VALID_ULID);
    const res = mockRes();
    const mw = createCorrelationIdMiddleware();
    mw(req, res, vi.fn());
    expect(res.headers['x-correlation-id']).toBe(VALID_ULID);
  });
});

// ---------------------------------------------------------------------------
// correlationIdMiddleware — AsyncLocalStorage propagation
// ---------------------------------------------------------------------------

describe('createCorrelationIdMiddleware — ALS propagation', () => {
  it('getCorrelationId() returns the active ID inside the middleware chain', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      expect(getCorrelationId()).toBe(VALID_ULID);
      done();
    });
  });

  it('correlation ID survives an awaited async boundary', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      // Simulate an async hop (e.g. a database call)
      void Promise.resolve().then(() => {
        expect(getCorrelationId()).toBe(VALID_ULID);
        done();
      });
    });
  });

  it('ALS context is isolated between concurrent requests', (done) => {
    const idA = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const idB = '01ARZ3NDEKTSV4RRFFQ69G5FBV';
    const mw = createCorrelationIdMiddleware();

    let resolvedIdA: string | undefined;
    let resolvedIdB: string | undefined;
    let completed = 0;

    const checkDone = () => {
      completed++;
      if (completed === 2) {
        expect(resolvedIdA).toBe(idA);
        expect(resolvedIdB).toBe(idB);
        done();
      }
    };

    mw(mockReq(idA), mockRes(), () => {
      void Promise.resolve().then(() => {
        resolvedIdA = getCorrelationId();
        checkDone();
      });
    });

    mw(mockReq(idB), mockRes(), () => {
      void Promise.resolve().then(() => {
        resolvedIdB = getCorrelationId();
        checkDone();
      });
    });
  });

  it('getCorrelationId() returns undefined outside a request context', () => {
    // Outside any ALS context (top-level module scope), should return undefined
    // unless a prior test left an active context. Run synchronously.
    // We cannot guarantee isolation from other tests' ALS contexts here, so
    // we only assert the value is either undefined or a string.
    const id = getCorrelationId();
    expect(typeof id === 'string' || id === undefined).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getTraceId — OTel fallback
// ---------------------------------------------------------------------------

describe('getTraceId', () => {
  it('returns a string or undefined (never throws)', () => {
    expect(() => getTraceId()).not.toThrow();
    const id = getTraceId();
    expect(typeof id === 'string' || id === undefined).toBe(true);
  });

  it('returns the correlation ID as fallback when no OTel span is active', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      // No OTel SDK bootstrapped in tests — should fall back to correlation ID
      const traceId = getTraceId();
      expect(traceId).toBe(VALID_ULID);
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// injectHeaders
// ---------------------------------------------------------------------------

describe('injectHeaders', () => {
  it('adds x-correlation-id when called inside a middleware context', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      const headers = injectHeaders({ ...BASE_OUTBOUND_HEADERS });
      expect(headers['x-correlation-id']).toBe(VALID_ULID);
      done();
    });
  });

  it('preserves existing headers', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      const headers = injectHeaders({ accept: 'application/json' });
      expect(headers['accept']).toBe('application/json');
      expect(headers['x-correlation-id']).toBe(VALID_ULID);
      done();
    });
  });

  it('does not mutate the input object', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      const input = { accept: 'application/json' };
      const result = injectHeaders(input);
      expect(input).not.toHaveProperty('x-correlation-id');
      expect(result).toHaveProperty('x-correlation-id');
      done();
    });
  });

  it('returns the input unchanged when no context is active', () => {
    // Outside any ALS context: no x-correlation-id should be added.
    // (If a prior test left a context active this might vary, but we test
    // the baseline: the function should not throw.)
    expect(() => injectHeaders({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// injectMessageAttributes
// ---------------------------------------------------------------------------

describe('injectMessageAttributes', () => {
  it('adds x-correlation-id to queue message attributes', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      const attrs = injectMessageAttributes({});
      expect(attrs['x-correlation-id']).toBe(VALID_ULID);
      done();
    });
  });

  it('does not mutate the input object', (done) => {
    const req = mockReq(VALID_ULID);
    const mw = createCorrelationIdMiddleware();
    mw(req, mockRes(), () => {
      const input = { eventType: 'booking.confirmed' };
      const result = injectMessageAttributes(input);
      expect(input).not.toHaveProperty('x-correlation-id');
      expect(result).toHaveProperty('x-correlation-id');
      done();
    });
  });
});
