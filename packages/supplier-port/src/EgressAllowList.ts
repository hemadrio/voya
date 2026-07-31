/**
 * EgressAllowList — config-driven pre-flight URL validation.
 *
 * Reads the allowed supplier hostnames from injected configuration
 * (SUPPLIER_ALLOWED_HOSTS). Fails at construction if the list is empty so a
 * misconfigured deployment refuses to start rather than allow unrestricted
 * egress (fail-closed policy).
 *
 * Delegates the full SSRF check (IP range, DNS rebinding, scheme/port
 * enforcement) to assertAllowedDestination from @travel/suppliers. The
 * config-driven list provides an additional admission gate: even a host that
 * passes the hardcoded allow-list in @travel/suppliers is blocked here if it
 * is not listed in SUPPLIER_ALLOWED_HOSTS for this deployment.
 *
 * This module is free of I/O and Node.js imports — pure, unit-testable.
 */

import {
  assertAllowedDestination,
  EgressDeniedError,
} from '@travel/suppliers';
import {
  SupplierEgressBlockedError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Logger interface (duck-typed — no @travel/observability import required)
// ---------------------------------------------------------------------------

export interface SecurityLogger {
  warn(
    obj: {
      event: string;
      supplierName: string;
      attemptedHost: string;
      correlationId: string;
      reason: string;
    },
    message: string,
  ): void;
}

const noopLogger: SecurityLogger = { warn: () => undefined };

// ---------------------------------------------------------------------------
// EgressAllowList
// ---------------------------------------------------------------------------

export interface EgressAllowListConfig {
  /**
   * Allowed supplier hostnames. Injected from SUPPLIER_ALLOWED_HOSTS config.
   * Must not be empty — construction throws if the array is empty or contains
   * only whitespace entries.
   */
  allowedHosts: ReadonlyArray<string>;
  /** Optional security event logger. */
  logger?: SecurityLogger | undefined;
}

export class EgressAllowList {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly logger: SecurityLogger;

  constructor(config: EgressAllowListConfig) {
    const cleaned = config.allowedHosts
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0);

    if (cleaned.length === 0) {
      throw new Error(
        'EgressAllowList: SUPPLIER_ALLOWED_HOSTS must not be empty. ' +
        'A missing or empty allow-list would allow unrestricted egress — refusing to start.',
      );
    }

    this.allowedHosts = new Set(cleaned);
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Assert that `urlString` is permitted.
   *
   * Two-layer check:
   *   1. Config-driven host list (this class).
   *   2. Hardcoded SSRF policy (@travel/suppliers assertAllowedDestination).
   *
   * Throws SupplierEgressBlockedError on any denial.
   * Emits a security-classified Pino log event with the attempted host.
   *
   * @param urlString - The outbound URL to validate.
   * @param supplierName - Supplier name for logging context.
   * @param correlationId - Inbound request correlation ID for log correlation.
   */
  assert(urlString: string, supplierName: string, correlationId: string): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      this.emitSecurityEvent(supplierName, urlString, correlationId, 'invalid URL');
      throw new SupplierEgressBlockedError(supplierName, correlationId, urlString);
    }

    const host = parsedUrl.hostname.toLowerCase();

    // Layer 1: config-driven list
    if (!this.allowedHosts.has(host)) {
      this.emitSecurityEvent(supplierName, host, correlationId, 'host not in SUPPLIER_ALLOWED_HOSTS');
      throw new SupplierEgressBlockedError(supplierName, correlationId, host);
    }

    // Layer 2: hardcoded SSRF policy from @travel/suppliers
    try {
      assertAllowedDestination(urlString);
    } catch (err) {
      const reason =
        err instanceof EgressDeniedError ? err.reason : 'SSRF policy violation';
      this.emitSecurityEvent(supplierName, host, correlationId, reason);
      throw new SupplierEgressBlockedError(supplierName, correlationId, host);
    }
  }

  private emitSecurityEvent(
    supplierName: string,
    attemptedHost: string,
    correlationId: string,
    reason: string,
  ): void {
    this.logger.warn(
      {
        event: 'EGRESS_BLOCKED',
        supplierName,
        attemptedHost,
        correlationId,
        reason,
      },
      `Outbound request to "${attemptedHost}" blocked by egress policy`,
    );
  }
}
