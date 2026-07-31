/**
 * Egress allow-list and pre-flight URL validation.
 *
 * This module is intentionally free of Node.js / framework imports so every
 * function can be tested in a pure unit context with no dependency setup.
 *
 * Two consumers:
 *   1. createHardenedClient (hardenedClient.ts) — used by every supplier adapter
 *   2. AI ToolRegistry (ai-orchestration) — first-party tool calls to the gateway
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AllowedDestination {
  /** Exact hostname (case-insensitive). IP literals are never placed here. */
  host: string;
  /** Schemes permitted for this destination. */
  allowedSchemes: ReadonlyArray<'https' | 'http'>;
  /**
   * Ports permitted. 'default' accepts the scheme default (443 for https,
   * 80 for http). Only ports listed here are accepted.
   */
  allowedPorts: ReadonlyArray<number> | 'default';
  /** Human-readable purpose for auditing and incident analysis. */
  purpose: string;
  /**
   * When true, any subdomain of `host` is also permitted.
   * Only set for providers that use customer-specific subdomains.
   * Default: false.
   */
  allowWildcardSubdomains?: boolean | undefined;
  /**
   * When true, the DNS rebinding IP-range check is skipped for this
   * destination. ONLY set for internal service-mesh destinations (e.g.
   * api-gateway.internal via ECS Service Connect) whose hostname inherently
   * resolves to a VPC-private or loopback address. Never set for external
   * supplier endpoints.
   */
  allowPrivateAddresses?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class EgressDeniedError extends Error {
  /** The host that was denied — safe to log in security events. */
  readonly attemptedHost: string;
  /** Brief reason code — never contains user data. */
  readonly reason: string;

  constructor(attemptedHost: string, reason: string) {
    super(`Egress denied for "${attemptedHost}": ${reason}`);
    this.name = 'EgressDeniedError';
    this.attemptedHost = attemptedHost;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------

/**
 * Central allow-list of every permitted egress destination.
 *
 * POLICY:
 *   - One entry per logical provider endpoint.
 *   - No wildcard schemes or ports.
 *   - allowWildcardSubdomains: true only for providers with customer subdomains
 *     (e.g. RapidAPI).
 *   - IP literals are never permitted in the host field; they are rejected by
 *     assertAllowedDestination before the allow-list is consulted.
 *   - To add a new destination, add an entry here and open a PR. The Semgrep
 *     no-direct-fetch rule will fail the build on any call that bypasses this
 *     list.
 */
export const ALLOWED_DESTINATIONS: ReadonlyArray<AllowedDestination> = [
  // ── Amadeus GDS (flights) ─────────────────────────────────────────────────
  {
    host: 'api.amadeus.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Amadeus GDS production — flight search and pricing',
  },
  {
    host: 'test.api.amadeus.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Amadeus GDS test environment',
  },
  // ── RapidAPI (hotels + cars) ──────────────────────────────────────────────
  // RapidAPI uses provider-specific hostnames like <provider>.p.rapidapi.com.
  // allowWildcardSubdomains is the opt-in to match *.p.rapidapi.com.
  {
    host: 'p.rapidapi.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'RapidAPI hotel and car-rental provider endpoints',
    allowWildcardSubdomains: true,
  },
  // ── Stripe ────────────────────────────────────────────────────────────────
  {
    host: 'api.stripe.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Stripe payment API — payment intents and charges',
  },
  // ── Anthropic Claude ─────────────────────────────────────────────────────
  {
    host: 'api.anthropic.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Anthropic Claude — AI-assisted itinerary generation',
  },
  // ── Google OIDC ───────────────────────────────────────────────────────────
  {
    host: 'accounts.google.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Google OIDC authorization endpoint',
  },
  {
    host: 'oauth2.googleapis.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Google OAuth2 token endpoint',
  },
  // ── Amazon SES ────────────────────────────────────────────────────────────
  // SES endpoint is regional; the eu-west-1 HTTPS endpoint is standard.
  {
    host: 'email.eu-west-1.amazonaws.com',
    allowedSchemes: ['https'],
    allowedPorts: 'default',
    purpose: 'Amazon SES — transactional email delivery',
  },
  // ── Internal API gateway (AI first-party tool calls) ─────────────────────
  // The AI orchestration service calls back into the gateway over the internal
  // ECS Service Connect mesh. The hostname resolves to a VPC-private address
  // (127.x.x.x sidecar proxy or 10.x.x.x container IP). allowPrivateAddresses
  // is set because the private IP is expected and intentional — the SSRF
  // threat model covers external hostnames resolving to internal addresses,
  // not service-mesh internal traffic.
  {
    host: 'api-gateway.internal',
    allowedSchemes: ['http'],
    allowedPorts: [3000],
    purpose: 'Internal API gateway — first-party AI tool calls via ECS Service Connect',
    allowPrivateAddresses: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Record<string, number> = {
  https: 443,
  http: 80,
};

/**
 * Returns true when the string looks like a raw IPv4 or IPv6 literal.
 * IP literals are always rejected — they cannot appear in the allow-list.
 */
function looksLikeIpLiteral(host: string): boolean {
  // IPv4: exactly four numeric groups separated by dots
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6: contains colons (including bracket-wrapped form [::1])
  if (host.includes(':')) return true;
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return false;
}

/**
 * Returns the effective port number for a URL.
 * Falls back to the scheme default when no explicit port is set.
 */
function effectivePort(url: URL): number | null {
  if (url.port !== '') return parseInt(url.port, 10);
  const def = DEFAULT_PORTS[url.protocol.replace(':', '')];
  return def !== undefined ? def : null;
}

/**
 * Find the entry in ALLOWED_DESTINATIONS whose host (possibly with wildcard
 * subdomain) matches the given hostname (case-insensitive).
 */
function findDestination(
  normalHost: string,
): AllowedDestination | undefined {
  for (const dest of ALLOWED_DESTINATIONS) {
    const destHost = dest.host.toLowerCase();
    if (normalHost === destHost) return dest;
    if (dest.allowWildcardSubdomains === true) {
      if (normalHost.endsWith(`.${destHost}`)) return dest;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main assertion
// ---------------------------------------------------------------------------

/**
 * Validate that `urlString` is a permitted egress destination.
 *
 * Checks (in order):
 *   1. URL is parseable.
 *   2. URL contains no userinfo (credentials in URLs are forbidden).
 *   3. Host is not a raw IP literal.
 *   4. Host matches an entry in ALLOWED_DESTINATIONS.
 *   5. Scheme is in the allowed schemes for that entry.
 *   6. Port (effective or default) is in the allowed ports for that entry.
 *
 * Throws `EgressDeniedError` on any violation. Returns the matching
 * `AllowedDestination` on success so callers can log the purpose.
 *
 * This function performs no I/O and has no side-effects.
 */
export function assertAllowedDestination(urlString: string): AllowedDestination {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new EgressDeniedError(urlString, 'invalid URL');
  }

  const host = url.hostname.toLowerCase();

  // Credentials in the URL are a security anti-pattern — reject outright.
  if (url.username !== '' || url.password !== '') {
    throw new EgressDeniedError(host, 'URL contains userinfo (credentials); inject credentials at request time');
  }

  // IP literals are never permit-listed.
  if (looksLikeIpLiteral(host)) {
    throw new EgressDeniedError(host, 'IP literal destinations are not permitted');
  }

  const dest = findDestination(host);
  if (dest === undefined) {
    throw new EgressDeniedError(host, 'host is not on the egress allow-list');
  }

  const scheme = url.protocol.replace(':', '') as 'https' | 'http';
  if (!(dest.allowedSchemes as string[]).includes(scheme)) {
    throw new EgressDeniedError(
      host,
      `scheme "${scheme}" is not permitted for this destination (allowed: ${dest.allowedSchemes.join(', ')})`,
    );
  }

  const port = effectivePort(url);
  if (dest.allowedPorts !== 'default') {
    if (port === null || !(dest.allowedPorts as number[]).includes(port)) {
      throw new EgressDeniedError(
        host,
        `port ${String(port)} is not permitted for this destination (allowed: ${(dest.allowedPorts as number[]).join(', ')})`,
      );
    }
  } else {
    // 'default' means only the scheme's default port is allowed.
    const defaultPort = DEFAULT_PORTS[scheme];
    if (port !== defaultPort) {
      throw new EgressDeniedError(
        host,
        `port ${String(port)} is not the default for scheme "${scheme}" (${String(defaultPort)})`,
      );
    }
  }

  return dest;
}
