/**
 * Typed SupplierError hierarchy.
 *
 * Every fault from a supplier adapter is normalised into one of these classes
 * before it leaves the port layer. Callers map to HTTP status codes via the
 * exhaustive switch in the controller layer — they never inspect raw provider
 * payloads.
 *
 * HTTP mapping (mirrors @travel/contracts ErrorCode):
 *   SupplierTimeoutError        → 504 SUPPLIER_TIMEOUT
 *   SupplierUnavailableError    → 502 SUPPLIER_UNAVAILABLE
 *   SupplierRejectedRequestError → 422 SUPPLIER_REJECTED
 *   SupplierEgressBlockedError  → 502 EGRESS_DENIED
 */

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class SupplierError extends Error {
  /** Human-readable supplier name for structured logging. */
  readonly supplierName: string;
  /** Correlation ID from the inbound request — forwarded in security events. */
  readonly correlationId: string;

  constructor(supplierName: string, correlationId: string, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.supplierName = supplierName;
    this.correlationId = correlationId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Concrete errors
// ---------------------------------------------------------------------------

/**
 * 504 — the supplier did not respond within the configured timeout.
 * Maps to ErrorCode.SUPPLIER_TIMEOUT.
 */
export class SupplierTimeoutError extends SupplierError {
  /** Configured timeout in milliseconds. */
  readonly timeoutMs: number;

  constructor(supplierName: string, correlationId: string, timeoutMs: number) {
    super(
      supplierName,
      correlationId,
      `Supplier "${supplierName}" did not respond within ${timeoutMs}ms`,
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 502 — the supplier is unreachable or returned a 5xx response.
 * Maps to ErrorCode.SUPPLIER_UNAVAILABLE.
 */
export class SupplierUnavailableError extends SupplierError {
  /** HTTP status returned, or undefined for network-level failures. */
  readonly httpStatus: number | undefined;

  constructor(
    supplierName: string,
    correlationId: string,
    httpStatus?: number | undefined,
  ) {
    const statusMsg =
      httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ' (network error)';
    super(
      supplierName,
      correlationId,
      `Supplier "${supplierName}" is unavailable${statusMsg}`,
    );
    this.httpStatus = httpStatus;
  }
}

/**
 * 422 — the supplier understood the request but rejected it (e.g. offer
 * expired, no availability, invalid parameters). Maps to ErrorCode.SUPPLIER_REJECTED.
 */
export class SupplierRejectedRequestError extends SupplierError {
  /** HTTP status from the supplier (typically 4xx). */
  readonly httpStatus: number;

  constructor(
    supplierName: string,
    correlationId: string,
    httpStatus: number,
    detail?: string | undefined,
  ) {
    super(
      supplierName,
      correlationId,
      detail !== undefined
        ? `Supplier "${supplierName}" rejected the request (HTTP ${httpStatus}): ${detail}`
        : `Supplier "${supplierName}" rejected the request (HTTP ${httpStatus})`,
    );
    this.httpStatus = httpStatus;
  }
}

/**
 * 502 — the outbound request was refused by the SSRF egress policy before
 * any socket was opened. Maps to ErrorCode.EGRESS_DENIED.
 *
 * The attempted host is available for security event logging but must NOT
 * be forwarded to the client-facing error response body.
 */
export class SupplierEgressBlockedError extends SupplierError {
  /** The hostname that was denied — log in security events, never in responses. */
  readonly attemptedHost: string;

  constructor(
    supplierName: string,
    correlationId: string,
    attemptedHost: string,
  ) {
    super(
      supplierName,
      correlationId,
      `Egress to supplier "${supplierName}" was blocked by the allow-list policy`,
    );
    this.attemptedHost = attemptedHost;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isSupplierError(err: unknown): err is SupplierError {
  return err instanceof SupplierError;
}
