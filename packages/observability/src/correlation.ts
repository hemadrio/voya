/**
 * Correlation ID middleware and helpers.
 *
 * - correlationIdMiddleware: reads/generates a ULID per-request, echoes it on
 *   the response, writes it to AsyncLocalStorage and OTel baggage (opportunistic).
 * - getCorrelationId(): reads the active correlation ID from ALS.
 * - getTraceId(): returns the OTel trace ID when a span is active, else the
 *   correlation ID — reference is never null.
 * - injectHeaders(): adds x-correlation-id and W3C traceparent to outbound headers.
 * - injectMessageAttributes(): adds the same fields to queue message attributes.
 *
 * OTel API is imported directly; when the SDK is not bootstrapped the API
 * returns a NoOp span with an invalid span context, so all OTel-dependent
 * paths fall through to the correlation ID fallback.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  trace,
  context as otelContext,
  propagation,
  isValidSpanContext,
} from '@opentelemetry/api';
import { createChildLogger } from './logger.js';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// ULID generation — Crockford's Base32, 26 chars, monotonically sortable
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode `value` into `chars` Crockford Base32 characters (big-endian).
 * `value` must fit in `chars * 5` bits.
 */
function base32EncodeNumber(value: number, chars: number): string {
  const out: string[] = new Array(chars).fill('0') as string[];
  let v = value;
  for (let i = chars - 1; i >= 0; i--) {
    const c = CROCKFORD[v & 31];
    out[i] = c ?? '0';
    v = Math.floor(v / 32);
  }
  return out.join('');
}

/** Generate a cryptographically random ULID. */
export function generateULID(): string {
  // 10 time characters = 48-bit millisecond timestamp (Crockford Base32)
  const timeStr = base32EncodeNumber(Date.now(), 10);

  // 16 random characters = 80 bits (5 bits each)
  const rb = randomBytes(10);
  let r = 0n;
  for (const b of rb) r = (r << 8n) | BigInt(b);
  const randOut: string[] = new Array(16).fill('0') as string[];
  for (let i = 15; i >= 0; i--) {
    randOut[i] = CROCKFORD[Number(r & 31n)] ?? '0';
    r >>= 5n;
  }
  return timeStr + randOut.join('');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Characters that must never appear in a header value (header injection). */
const UNSAFE_HEADER_RE = /[\r\n\0\x0b\x0c]/;
const MAX_CORRELATION_ID_LEN = 64;

/** True when id is a valid ULID or UUID v4 with no injection characters. */
export function isValidCorrelationId(id: string): boolean {
  if (id.length > MAX_CORRELATION_ID_LEN) return false;
  if (UNSAFE_HEADER_RE.test(id)) return false;
  return ULID_RE.test(id) || UUID_V4_RE.test(id);
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

interface CorrelationStore {
  readonly correlationId: string;
}

const als = new AsyncLocalStorage<CorrelationStore>();

/** Return the correlation ID bound to the current async context, if any. */
export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}

/**
 * Return the active trace reference.
 *
 * Tries the OTel API first (returns the OTel trace ID if a valid span is
 * active).  Falls back to the ALS correlation ID so reference is never null
 * even before the OTel SDK is bootstrapped.
 */
export function getTraceId(): string | undefined {
  try {
    const span = trace.getSpan(otelContext.active());
    if (span !== undefined) {
      const sc = span.spanContext();
      if (isValidSpanContext(sc)) return sc.traceId;
    }
  } catch {
    // OTel API not loaded — fall through to correlation ID
  }
  return getCorrelationId();
}

// ---------------------------------------------------------------------------
// Outbound injection helpers
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of `headers` with x-correlation-id and (when a span
 * is active) W3C traceparent added.  Safe to call outside a request context —
 * silently omits the fields when no context is active.
 */
export function injectHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  const cid = getCorrelationId();
  if (cid !== undefined) result['x-correlation-id'] = cid;

  try {
    const span = trace.getSpan(otelContext.active());
    if (span !== undefined) {
      const sc = span.spanContext();
      if (isValidSpanContext(sc)) {
        const flags = sc.traceFlags.toString(16).padStart(2, '0');
        result['traceparent'] = `00-${sc.traceId}-${sc.spanId}-${flags}`;
      }
    }
  } catch {
    // OTel not available
  }

  return result;
}

/** Message attribute bag — string → string only (SQS StringValue / AMQP headers). */
export type MessageAttributes = Record<string, string>;

/**
 * Return a shallow copy of `attrs` with x-correlation-id and (when a span is
 * active) W3C traceparent added — ready to pass as SQS MessageAttributes or
 * AMQP message headers for the notification consumer to restore context.
 */
export function injectMessageAttributes(attrs: MessageAttributes): MessageAttributes {
  const result: MessageAttributes = { ...attrs };
  const cid = getCorrelationId();
  if (cid !== undefined) result['x-correlation-id'] = cid;

  try {
    const span = trace.getSpan(otelContext.active());
    if (span !== undefined) {
      const sc = span.spanContext();
      if (isValidSpanContext(sc)) {
        const flags = sc.traceFlags.toString(16).padStart(2, '0');
        result['traceparent'] = `00-${sc.traceId}-${sc.spanId}-${flags}`;
      }
    }
  } catch {
    // OTel not available
  }

  return result;
}

// ---------------------------------------------------------------------------
// Express-compatible inline types (no express import in this package)
// ---------------------------------------------------------------------------

interface CorrelationRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string | undefined;
  log?: RequestChildLogger | undefined;
  method?: string | undefined;
  path?: string | undefined;
  url?: string | undefined;
}

interface CorrelationResponse {
  setHeader(name: string, value: string): this;
}

type CorrelationNext = (err?: unknown) => void;

interface RequestChildLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface CorrelationMiddlewareOptions {
  /** Root Pino logger — a request-scoped child is created and attached to req.log. */
  readonly logger?: Logger | undefined;
}

/**
 * Returns an Express middleware that:
 *  1. Validates the inbound x-correlation-id header (ULID / UUID v4 allow-list).
 *     A malformed value is silently replaced with a fresh ULID — never echoed.
 *  2. Echoes the resolved ID on every response via x-correlation-id header.
 *  3. Attaches the ID to req.correlationId for downstream access.
 *  4. Creates a request-scoped child logger (if a root logger is provided) and
 *     attaches it to req.log.
 *  5. Writes the ID to OTel baggage (opportunistic — no-op when SDK absent).
 *  6. Runs the remainder of the chain inside an AsyncLocalStorage context so
 *     domain services can call getCorrelationId() without parameter threading.
 */
export function createCorrelationIdMiddleware(
  options?: CorrelationMiddlewareOptions,
): (req: CorrelationRequest, res: CorrelationResponse, next: CorrelationNext) => void {
  return function correlationIdMiddleware(
    req: CorrelationRequest,
    res: CorrelationResponse,
    next: CorrelationNext,
  ): void {
    // 1. Resolve correlation ID
    const rawInbound = req.headers['x-correlation-id'];
    const inbound = Array.isArray(rawInbound) ? rawInbound[0] : rawInbound;
    const correlationId =
      typeof inbound === 'string' && isValidCorrelationId(inbound)
        ? inbound
        : generateULID();

    // 2. Echo on every response
    res.setHeader('x-correlation-id', correlationId);

    // 3. Attach to request
    req.correlationId = correlationId;

    // 4. Request-scoped child logger
    if (options?.logger !== undefined) {
      const traceId = getTraceId();
      const child = createChildLogger(options.logger, {
        correlationId,
        ...(traceId !== undefined ? { traceId } : {}),
      });
      req.log = child as unknown as RequestChildLogger;
    }

    // 5 + 6. Run inside ALS context; opportunistically also set OTel baggage.
    als.run({ correlationId }, () => {
      try {
        const existing = propagation.getBaggage(otelContext.active());
        const updated = (existing ?? propagation.createBaggage()).setEntry(
          'correlation-id',
          { value: correlationId },
        );
        const ctx = propagation.setBaggage(otelContext.active(), updated);
        otelContext.with(ctx, next);
        return;
      } catch {
        // OTel API not available or not bootstrapped — run without baggage
      }
      next();
    });
  };
}
