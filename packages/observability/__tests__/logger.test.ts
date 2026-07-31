import { Writable } from 'node:stream';
import { createLogger, createChildLogger } from '../src/logger.js';
import type { LogContext } from '../src/context.js';
import {
  PII_FIXTURES,
  HEADER_FIXTURES,
  PII_ERROR_FIXTURE,
  SENSITIVE_VALUES,
} from './fixtures/pii-fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CaptureStream {
  stream: Writable;
  lines(): string[];
  lastParsed(): Record<string, unknown>;
}

function createCapture(): CaptureStream {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      chunks.push(chunk.toString('utf-8').trim());
      cb();
    },
  });
  return {
    stream,
    lines: () => chunks.filter((l) => l.length > 0),
    lastParsed: () => {
      const last = chunks.filter((l) => l.startsWith('{')).pop();
      if (!last) throw new Error('No JSON output captured');
      return JSON.parse(last) as Record<string, unknown>;
    },
  };
}

function waitDrain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

describe('createLogger — construction', () => {
  it('throws when service name is empty', () => {
    expect(() => createLogger({ service: '' })).toThrow('"service" option is required');
  });

  it('throws when service name is only whitespace', () => {
    expect(() => createLogger({ service: '   ' })).toThrow('"service" option is required');
  });
});

// ---------------------------------------------------------------------------
// JSON output shape
// ---------------------------------------------------------------------------

describe('createLogger — JSON output shape', () => {
  it('emits valid single-line JSON', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'test-svc' }, cap.stream);
    log.info('hello world');
    await waitDrain();
    const lines = cap.lines();
    expect(lines.length).toBeGreaterThan(0);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });

  it('includes required fields: level, time, service, env, msg', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'shape-svc' }, cap.stream);
    log.info('shape test');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['level']).toBe('info');
    expect(typeof parsed['time']).toBe('string');
    expect(parsed['service']).toBe('shape-svc');
    expect(typeof parsed['env']).toBe('string');
    expect(parsed['msg']).toBe('shape test');
  });

  it('includes version in base bindings when supplied', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'ver-svc', version: '1.2.3' }, cap.stream);
    log.info('version test');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['version']).toBe('1.2.3');
  });

  it('timestamp is ISO 8601 string', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'ts-svc' }, cap.stream);
    log.info('timestamp test');
    await waitDrain();
    const parsed = cap.lastParsed();
    const time = parsed['time'];
    expect(typeof time).toBe('string');
    expect(new Date(time as string).toISOString()).toBe(time);
  });
});

// ---------------------------------------------------------------------------
// Level filtering
// ---------------------------------------------------------------------------

describe('createLogger — level filtering', () => {
  const envBackup = process.env['LOG_LEVEL'];

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env['LOG_LEVEL'];
    } else {
      process.env['LOG_LEVEL'] = envBackup;
    }
  });

  it('suppresses debug logs at default info level', async () => {
    delete process.env['LOG_LEVEL'];
    const cap = createCapture();
    const log = createLogger({ service: 'filter-svc' }, cap.stream);
    log.debug('should be filtered');
    await waitDrain();
    expect(cap.lines()).toHaveLength(0);
  });

  it('emits debug logs when LOG_LEVEL=debug and not production', async () => {
    process.env['LOG_LEVEL'] = 'debug';
    const nodeEnvBackup = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    const cap = createCapture();
    const log = createLogger({ service: 'debug-svc' }, cap.stream);
    log.debug('should appear');
    await waitDrain();
    expect(cap.lines().length).toBeGreaterThan(0);
    process.env['NODE_ENV'] = nodeEnvBackup;
  });

  it('throws on invalid LOG_LEVEL', () => {
    process.env['LOG_LEVEL'] = 'supersecretlevel';
    expect(() => createLogger({ service: 'invalid-svc' })).toThrow(
      'Invalid LOG_LEVEL: "supersecretlevel"'
    );
  });
});

// ---------------------------------------------------------------------------
// Child logger context merging
// ---------------------------------------------------------------------------

describe('createChildLogger', () => {
  it('inherits service and env from parent', async () => {
    const cap = createCapture();
    const parent = createLogger({ service: 'parent-svc' }, cap.stream);
    const context: LogContext = { correlationId: 'corr-001' };
    const child = createChildLogger(parent, context);
    child.info('child log');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['service']).toBe('parent-svc');
    expect(parsed['correlationId']).toBe('corr-001');
  });

  it('merges all typed context fields', async () => {
    const cap = createCapture();
    const parent = createLogger({ service: 'ctx-svc' }, cap.stream);
    const context: LogContext = {
      correlationId: 'corr-abc',
      traceId: 'trace-xyz',
      userId: 'user-123',
      operation: 'book-flight',
      resource: 'bookings',
      supplierName: 'AMADEUS',
      bookingId: 'bk-001',
    };
    const child = createChildLogger(parent, context);
    child.info('full context');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['correlationId']).toBe('corr-abc');
    expect(parsed['traceId']).toBe('trace-xyz');
    expect(parsed['userId']).toBe('user-123');
    expect(parsed['operation']).toBe('book-flight');
    expect(parsed['resource']).toBe('bookings');
    expect(parsed['supplierName']).toBe('AMADEUS');
    expect(parsed['bookingId']).toBe('bk-001');
  });

  it('omits undefined context fields from bindings', async () => {
    const cap = createCapture();
    const parent = createLogger({ service: 'sparse-svc' }, cap.stream);
    const child = createChildLogger(parent, { correlationId: 'only-corr' });
    child.info('sparse context');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['correlationId']).toBe('only-corr');
    expect(parsed['traceId']).toBeUndefined();
    expect(parsed['userId']).toBeUndefined();
  });

  it('works with no HTTP context — supports notification consumer', async () => {
    const cap = createCapture();
    const parent = createLogger({ service: 'notification-consumer' }, cap.stream);
    const child = createChildLogger(parent, { correlationId: 'msg-id-001' });
    child.info('processing notification');
    await waitDrain();
    const parsed = cap.lastParsed();
    expect(parsed['correlationId']).toBe('msg-id-001');
    expect(parsed['service']).toBe('notification-consumer');
  });
});

// ---------------------------------------------------------------------------
// PII redaction — negative tests
// ---------------------------------------------------------------------------

function assertNoSensitiveValues(serialized: string): void {
  for (const value of SENSITIVE_VALUES) {
    expect(serialized).not.toContain(value);
  }
}

describe('PII redaction — negative tests', () => {
  it('redacts top-level email field', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info({ email: PII_FIXTURES.traveler.email }, 'top-level email');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain(PII_FIXTURES.traveler.email);
  });

  it('redacts traveler object with email, dateOfBirth, passportNumber', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info({ traveler: PII_FIXTURES.traveler }, 'traveler record');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain(PII_FIXTURES.traveler.email);
    expect(raw).not.toContain(PII_FIXTURES.traveler.passportNumber);
  });

  it('redacts passwordHash', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info(PII_FIXTURES.credentials, 'credentials log');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain(PII_FIXTURES.credentials.passwordHash);
  });

  it('redacts nested email in HTTP headers (authorization, stripe-signature)', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info(HEADER_FIXTURES, 'incoming request');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.FAKE');
    expect(raw).not.toContain('FAKESIGNATUREHEX');
  });

  it('redacts PII in array of travelers', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info(
      { passengers: [PII_FIXTURES.traveler, PII_FIXTURES.travelerTwo] },
      'multi-passenger booking'
    );
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain(PII_FIXTURES.traveler.email);
    expect(raw).not.toContain(PII_FIXTURES.travelerTwo.email);
    expect(raw).not.toContain(PII_FIXTURES.travelerTwo.passportNumber);
  });

  it('redacts email nested three levels deep in an offer snapshot', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.info({ offer: PII_FIXTURES.offerSnapshot }, 'offer snapshot log');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain('nested.deep@example.com');
    expect(raw).not.toContain('Z11111111');
  });

  it('scrubs email from Error message and stack strings', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'redact-svc' }, cap.stream);
    log.error({ err: PII_ERROR_FIXTURE }, 'error with PII in stack');
    await waitDrain();
    const raw = cap.lines().join('');
    expect(raw).not.toContain('pii.embed@example.com');
    // Passport number A99887766 has 8 digits — matches LONG_DIGIT_RE (\b\d{7,}\b)
    expect(raw).not.toContain('99887766');
  });

  it('MASTER negative test — full PII fixture log produces no raw sensitive values', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'master-redact-svc' }, cap.stream);
    log.warn(
      {
        traveler: PII_FIXTURES.traveler,
        passengers: [PII_FIXTURES.traveler, PII_FIXTURES.travelerTwo],
        offer: PII_FIXTURES.offerSnapshot,
        credentials: PII_FIXTURES.credentials,
        ...HEADER_FIXTURES,
        err: PII_ERROR_FIXTURE,
      },
      'combined PII log'
    );
    await waitDrain();
    const raw = cap.lines().join('');
    assertNoSensitiveValues(raw);
  });
});

// ---------------------------------------------------------------------------
// Circular reference — must not throw
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles circular references without throwing', async () => {
    const cap = createCapture();
    const log = createLogger({ service: 'circ-svc' }, cap.stream);
    const obj: Record<string, unknown> = { id: 'circ-001' };
    obj['self'] = obj;
    expect(() => log.info({ data: obj }, 'circular ref')).not.toThrow();
    await waitDrain();
    expect(cap.lines().length).toBeGreaterThan(0);
  });
});
