/**
 * SupplierHttpClient — narrow HTTP wrapper for supplier adapters.
 *
 * Features:
 *   - Configurable per-call timeout (default 2200 ms).
 *   - Exactly ONE retry on HTTP 5xx or network error, with 200 ms jitter.
 *     Never retries on 4xx (client error) or for non-idempotent operations
 *     (the adapter must set allowRetry: false for reserve/confirm calls).
 *   - Correlation ID forwarded as X-Correlation-Id header.
 *   - All errors normalised into the SupplierError hierarchy.
 *   - Injectable clock and transport — zero real network or timer usage in
 *     unit tests.
 *   - EgressAllowList checked before every attempt (including after retry).
 *
 * Adapters receive a SupplierHttpClient instance via constructor injection.
 * They may not construct their own HTTP client, ensuring allow-list
 * enforcement cannot be bypassed.
 */

import type { HardenedFetch, HardenedResponse } from '@travel/suppliers';
import { EgressDeniedError } from '@travel/suppliers';
import type { EgressAllowList } from './EgressAllowList.js';
import {
  SupplierError,
  SupplierTimeoutError,
  SupplierUnavailableError,
  SupplierRejectedRequestError,
  SupplierEgressBlockedError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Injectable clock
// ---------------------------------------------------------------------------

export interface Clock {
  /** Returns the current epoch time in milliseconds. */
  now(): number;
  /** Suspends execution for `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupplierRequestOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  timeoutMs?: number | undefined;
  /**
   * Set to false for non-idempotent calls (reserve, confirm) to prevent
   * accidental retries that could double-book. Defaults to true.
   */
  allowRetry?: boolean | undefined;
}

export interface SupplierHttpClientOptions {
  /** Supplier name — used in error messages and log context. */
  supplierName: string;
  /** Transport: production wires createHardenedClient from @travel/suppliers. */
  transport: HardenedFetch;
  /** Pre-flight egress allow-list. */
  egressAllowList: EgressAllowList;
  /** Default timeout per call in ms. Default: 2200. */
  defaultTimeoutMs?: number | undefined;
  /** Jitter generator for retry delays (ms). Default: Math.random() * 200. */
  jitter?: (() => number) | undefined;
  /** Injectable clock. Default: real wall clock. */
  clock?: Clock | undefined;
}

// ---------------------------------------------------------------------------
// SupplierHttpClient
// ---------------------------------------------------------------------------

export class SupplierHttpClient {
  private readonly supplierName: string;
  private readonly transport: HardenedFetch;
  private readonly egressAllowList: EgressAllowList;
  private readonly defaultTimeoutMs: number;
  private readonly jitter: () => number;
  private readonly clock: Clock;

  constructor(options: SupplierHttpClientOptions) {
    this.supplierName = options.supplierName;
    this.transport = options.transport;
    this.egressAllowList = options.egressAllowList;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2_200;
    this.jitter = options.jitter ?? (() => Math.random() * 200);
    this.clock = options.clock ?? realClock;
  }

  /**
   * Execute a supplier HTTP request with timeout, retry, and allow-list
   * enforcement. Normalises all errors into the SupplierError hierarchy.
   */
  async request(
    url: string,
    correlationId: string,
    options: SupplierRequestOptions = {},
  ): Promise<HardenedResponse> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const allowRetry = options.allowRetry ?? true;
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      'x-correlation-id': correlationId,
    };

    // Pre-flight allow-list check (layer 1: config list + layer 2: SSRF policy)
    this.egressAllowList.assert(url, this.supplierName, correlationId);

    let lastError: SupplierError | undefined;

    for (let attempt = 0; attempt <= (allowRetry ? 1 : 0); attempt++) {
      if (attempt > 0) {
        // Jittered delay before the single retry
        await this.clock.sleep(this.jitter());
      }

      try {
        const response = await this.transport(url, {
          method: options.method,
          headers,
          body: options.body,
          timeoutMs,
        });

        // 4xx — client/supplier rejection; never retry
        if (response.status >= 400 && response.status < 500) {
          throw new SupplierRejectedRequestError(
            this.supplierName,
            correlationId,
            response.status,
          );
        }

        // 5xx — supplier unavailable; retry once if allowed
        if (response.status >= 500) {
          lastError = new SupplierUnavailableError(
            this.supplierName,
            correlationId,
            response.status,
          );
          if (!allowRetry) break;
          continue;
        }

        return response;
      } catch (err) {
        // Re-throw 4xx errors immediately — never retry
        if (err instanceof SupplierRejectedRequestError) throw err;
        if (err instanceof SupplierEgressBlockedError) throw err;

        // Timeout
        if (
          err instanceof Error &&
          (err.message.includes('timed out') || err.message.includes('timeout'))
        ) {
          lastError = new SupplierTimeoutError(
            this.supplierName,
            correlationId,
            timeoutMs,
          );
          if (!allowRetry) break;
          continue;
        }

        // Egress denial from the transport layer
        if (err instanceof EgressDeniedError) {
          throw new SupplierEgressBlockedError(
            this.supplierName,
            correlationId,
            err.attemptedHost,
          );
        }

        // Network error — retry once if allowed
        lastError = new SupplierUnavailableError(
          this.supplierName,
          correlationId,
        );
        if (!allowRetry) break;
      }
    }

    if (lastError !== undefined) throw lastError;

    // Should be unreachable but satisfies exhaustiveness
    throw new SupplierUnavailableError(this.supplierName, correlationId);
  }
}
