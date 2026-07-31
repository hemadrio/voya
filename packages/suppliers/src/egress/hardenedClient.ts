/**
 * Hardened HTTP client factory.
 *
 * createHardenedClient returns a fetch-like async function that:
 *   1. Calls assertAllowedDestination on the URL (allow-list check).
 *   2. Resolves DNS and validates every returned address against blocked IP
 *      ranges — mitigating DNS rebinding. If ANY resolved address is blocked
 *      the request is refused before a socket is opened.
 *   3. Passes a custom `lookup` to the http/https Agent so the same DNS check
 *      runs again at connect time, closing the TOCTOU window.
 *   4. Manually handles redirects: each hop is re-validated through steps 1-2.
 *      Automatic redirects are disabled (maxRedirects: 0 equivalent).
 *   5. Enforces the 2 200 ms supplier timeout.
 *   6. Wraps every call with a circuit breaker (5 failures / 10 s, half-open
 *      after 30 s).
 *
 * Callers inject credentials at request time (Authorization header, etc.) —
 * never embedded in the URL or in this module.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as dnsPromises from 'node:dns/promises';
import { assertAllowedDestination, EgressDeniedError } from './egressPolicy.js';
import { isBlockedAddress } from './ipRanges.js';
import { CircuitBreaker, CircuitBreakerOptions } from './circuitBreaker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DnsEntry {
  address: string;
  family: 4 | 6;
}

/** Injected DNS lookup function — replace with a mock in tests. */
export type DnsLookupFn = (hostname: string) => Promise<DnsEntry[]>;

export interface HardenedResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Record<string, string | string[] | undefined>;
  /** Whether the status is in the 2xx range. */
  ok: boolean;
  /** Read the response body as a UTF-8 string. */
  text(): Promise<string>;
  /** Parse the response body as JSON. */
  json<T>(): Promise<T>;
}

export interface HardenedRequestOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | Buffer | undefined;
  /** Override the default 2200 ms timeout for this request. */
  timeoutMs?: number | undefined;
}

export interface HardenedClientOptions {
  /** Injectable DNS resolver. Defaults to node:dns/promises.lookup with {all:true}. */
  dnsLookup?: DnsLookupFn | undefined;
  /** Timeout for each supplier request in ms. Default: 2200. */
  timeoutMs?: number | undefined;
  /** Maximum number of redirects to follow. Default: 3. */
  maxRedirects?: number | undefined;
  /** Circuit breaker options (used to construct a new CircuitBreaker). */
  circuitBreaker?: CircuitBreakerOptions | undefined;
  /** Injectable CircuitBreaker instance. Takes precedence over circuitBreaker options. */
  breakerInstance?: CircuitBreaker | undefined;
  /** Security event emitter — called on any denial with the attempted host. */
  onEgressDenied?: ((host: string, reason: string) => void) | undefined;
}

export type HardenedFetch = (
  url: string,
  options?: HardenedRequestOptions,
) => Promise<HardenedResponse>;

// ---------------------------------------------------------------------------
// Default DNS resolver
// ---------------------------------------------------------------------------

const defaultDnsLookup: DnsLookupFn = async (hostname: string): Promise<DnsEntry[]> => {
  const results = await dnsPromises.lookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveAndValidate(
  hostname: string,
  dnsLookup: DnsLookupFn,
  onEgressDenied: ((host: string, reason: string) => void) | undefined,
): Promise<DnsEntry[]> {
  const entries = await dnsLookup(hostname);

  if (entries.length === 0) {
    const reason = 'DNS resolution returned no addresses';
    if (onEgressDenied !== undefined) onEgressDenied(hostname, reason);
    throw new EgressDeniedError(hostname, reason);
  }

  for (const entry of entries) {
    if (isBlockedAddress(entry.address, entry.family)) {
      const reason = `resolved address ${entry.address} is in a blocked range (RFC1918 / loopback / link-local / metadata endpoint)`;
      if (onEgressDenied !== undefined) onEgressDenied(hostname, reason);
      throw new EgressDeniedError(hostname, reason);
    }
  }

  return entries;
}

function makeAgentLookup(
  hostname: string,
  dnsLookup: DnsLookupFn,
  onEgressDenied: ((host: string, reason: string) => void) | undefined,
): (
  host: string,
  options: Record<string, unknown>,
  callback: (err: Error | null, address: string, family: number) => void,
) => void {
  return (_host, _options, callback) => {
    dnsLookup(hostname)
      .then((entries) => {
        if (entries.length === 0) {
          callback(new EgressDeniedError(hostname, 'DNS resolution returned no addresses'), '', 4);
          return;
        }
        for (const entry of entries) {
          if (isBlockedAddress(entry.address, entry.family)) {
            const reason = `resolved address ${entry.address} is in a blocked range`;
            if (onEgressDenied !== undefined) onEgressDenied(hostname, reason);
            callback(new EgressDeniedError(hostname, reason), '', entry.family);
            return;
          }
        }
        const first = entries[0];
        if (first === undefined) {
          callback(new EgressDeniedError(hostname, 'no valid address found'), '', 4);
          return;
        }
        callback(null, first.address, first.family);
      })
      .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), '', 4));
  };
}

function nodeRequest(
  url: URL,
  options: HardenedRequestOptions,
  agentLookup: ReturnType<typeof makeAgentLookup> | undefined,
  timeoutMs: number,
): Promise<HardenedResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const Module = isHttps ? https : http;
    const AgentClass = isHttps ? https.Agent : http.Agent;

    const agentOpts = agentLookup !== undefined ? { lookup: agentLookup as never } : {};
    const agent = new AgentClass(agentOpts);

    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port !== '' ? parseInt(url.port, 10) : undefined,
      path: url.pathname + url.search,
      method: options.method ?? 'GET',
      headers: options.headers,
      agent,
    };

    const req = Module.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k] = v;
        }

        const response: HardenedResponse = {
          status,
          headers,
          ok: status >= 200 && status < 300,
          text: () => Promise.resolve(body),
          json: <T>() => Promise.resolve(JSON.parse(body) as T),
        };
        resolve(response);
      });
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a hardened HTTP client with allow-list enforcement, DNS-rebinding
 * protection, manual redirect handling, timeout, and circuit breaker.
 */
export function createHardenedClient(options: HardenedClientOptions = {}): HardenedFetch {
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  const timeoutMs = options.timeoutMs ?? 2_200;
  const maxRedirects = options.maxRedirects ?? 3;
  const breaker = options.breakerInstance ?? new CircuitBreaker(options.circuitBreaker);
  const onEgressDenied = options.onEgressDenied;

  return async function hardenedFetch(
    url: string,
    reqOptions: HardenedRequestOptions = {},
  ): Promise<HardenedResponse> {
    // Check circuit breaker before doing anything.
    if (!breaker.canRequest()) {
      throw Object.assign(
        new Error('Circuit breaker is OPEN — supplier is degraded'),
        { code: 'SUPPLIER_UNAVAILABLE' },
      );
    }

    let currentUrl = url;
    let hops = 0;

    for (;;) {
      // Step 1: allow-list check (throws EgressDeniedError on denial)
      let dest;
      try {
        dest = assertAllowedDestination(currentUrl);
      } catch (err) {
        if (err instanceof EgressDeniedError && onEgressDenied !== undefined) {
          onEgressDenied(err.attemptedHost, err.reason);
        }
        throw err;
      }

      // Step 2: DNS pre-flight (validates all resolved addresses).
      // Skipped for internal service-mesh destinations marked allowPrivateAddresses.
      const parsedUrl = new URL(currentUrl);
      if (dest.allowPrivateAddresses !== true) {
        await resolveAndValidate(parsedUrl.hostname, dnsLookup, onEgressDenied);
      }

      // Step 3: agent-level lookup hook (closes TOCTOU window at connect time).
      // Internal destinations also bypass this check.
      const agentLookup =
        dest.allowPrivateAddresses === true
          ? undefined
          : makeAgentLookup(parsedUrl.hostname, dnsLookup, onEgressDenied);

      // Step 4: make the request (no automatic redirect following)
      let response: HardenedResponse;
      try {
        response = await nodeRequest(
          parsedUrl,
          { ...reqOptions, timeoutMs: reqOptions.timeoutMs ?? timeoutMs },
          agentLookup,
          reqOptions.timeoutMs ?? timeoutMs,
        );
      } catch (err) {
        breaker.recordFailure();
        throw err;
      }

      // Step 5: handle redirects manually
      const isRedirect =
        response.status >= 300 &&
        response.status < 400 &&
        response.headers['location'] !== undefined;

      if (!isRedirect) {
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          breaker.recordSuccess();
        } else {
          breaker.recordFailure();
        }
        void dest; // mark as used
        return response;
      }

      // Redirect: validate the Location header before following.
      hops += 1;
      if (hops > maxRedirects) {
        breaker.recordFailure();
        throw new EgressDeniedError(
          parsedUrl.hostname,
          `too many redirects (max ${maxRedirects})`,
        );
      }

      const location = response.headers['location'];
      if (typeof location !== 'string') {
        breaker.recordFailure();
        throw new EgressDeniedError(parsedUrl.hostname, 'redirect Location header is missing or invalid');
      }

      // Re-validate the redirect target. assertAllowedDestination on the next
      // iteration will reject it if it is not on the allow-list.
      currentUrl = new URL(location, currentUrl).toString();
    }
  };
}
