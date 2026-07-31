/**
 * Mock DNS resolver fixture.
 *
 * Provides a factory that returns a DnsLookupFn backed by a static mapping,
 * allowing egress tests to run offline with no real DNS queries.
 */
import type { DnsEntry, DnsLookupFn } from '../../src/egress/hardenedClient.js';

export type HostMapping = Record<string, DnsEntry[]>;

/**
 * Build a mock DnsLookupFn from a hostname→addresses map.
 * Throws a realistic ENOTFOUND error for unmapped hostnames.
 */
export function makeResolver(mapping: HostMapping): DnsLookupFn {
  return async (hostname: string): Promise<DnsEntry[]> => {
    const entries = mapping[hostname];
    if (entries === undefined) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
        hostname,
      });
      throw err;
    }
    return entries;
  };
}

// ── Pre-built fixtures ────────────────────────────────────────────────────

export const PUBLIC_RESOLVER = makeResolver({
  'api.amadeus.com': [{ address: '203.0.113.10', family: 4 }],
  'api.stripe.com': [{ address: '203.0.113.20', family: 4 }],
  'api.anthropic.com': [{ address: '203.0.113.30', family: 4 }],
  'accounts.google.com': [{ address: '203.0.113.40', family: 4 }],
  'hotels-provider.p.rapidapi.com': [{ address: '203.0.113.50', family: 4 }],
  'api-gateway.internal': [{ address: '10.0.1.5', family: 4 }], // internal — private but expected
});

/** A resolver where api.amadeus.com resolves to a private RFC1918 address. */
export const REBINDING_RESOLVER = makeResolver({
  'api.amadeus.com': [{ address: '192.168.1.100', family: 4 }],
});

/** A resolver where a host resolves to the metadata endpoint. */
export const METADATA_RESOLVER = makeResolver({
  'api.amadeus.com': [{ address: '169.254.169.254', family: 4 }],
});

/** A resolver with both a public and a private address — must be blocked. */
export const MIXED_RESOLVER = makeResolver({
  'api.amadeus.com': [
    { address: '203.0.113.10', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ],
});

/** A resolver that returns a valid public IP for the internal gateway. */
export const GATEWAY_RESOLVER = makeResolver({
  'api-gateway.internal': [{ address: '10.0.1.5', family: 4 }],
});
