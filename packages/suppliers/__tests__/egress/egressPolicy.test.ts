import { assertAllowedDestination, EgressDeniedError, ALLOWED_DESTINATIONS } from '../../src/egress/egressPolicy.js';

describe('assertAllowedDestination — allow-list matching', () => {
  // ── Allowed cases ──────────────────────────────────────────────────────────

  it('accepts an allowed HTTPS host at the default port', () => {
    const dest = assertAllowedDestination('https://api.amadeus.com/v2/shopping/flight-offers');
    expect(dest.host).toBe('api.amadeus.com');
    expect(dest.purpose).toMatch(/Amadeus/);
  });

  it('accepts Stripe at default HTTPS port', () => {
    const dest = assertAllowedDestination('https://api.stripe.com/v1/payment_intents');
    expect(dest.host).toBe('api.stripe.com');
  });

  it('accepts Anthropic HTTPS endpoint', () => {
    const dest = assertAllowedDestination('https://api.anthropic.com/v1/messages');
    expect(dest.host).toBe('api.anthropic.com');
  });

  it('accepts Google OIDC endpoint', () => {
    const dest = assertAllowedDestination('https://accounts.google.com/o/oauth2/token');
    expect(dest.host).toBe('accounts.google.com');
  });

  it('accepts internal gateway over HTTP on port 3000', () => {
    const dest = assertAllowedDestination('http://api-gateway.internal:3000/v1/flights/search');
    expect(dest.host).toBe('api-gateway.internal');
  });

  it('accepts case-insensitive hostname (uppercase)', () => {
    const dest = assertAllowedDestination('https://API.AMADEUS.COM/v2/shopping');
    expect(dest.host).toBe('api.amadeus.com');
  });

  it('accepts a valid RapidAPI wildcard subdomain', () => {
    const dest = assertAllowedDestination('https://hotels-provider.p.rapidapi.com/hotels/search');
    expect(dest.allowWildcardSubdomains).toBe(true);
  });

  // ── Denied: wrong scheme ──────────────────────────────────────────────────

  it('rejects HTTP when only HTTPS is allowed (Amadeus)', () => {
    expect(() => assertAllowedDestination('http://api.amadeus.com/v2/shopping'))
      .toThrow(EgressDeniedError);
  });

  it('rejects HTTPS when only HTTP is allowed (internal gateway)', () => {
    expect(() => assertAllowedDestination('https://api-gateway.internal:3000/v1/flights/search'))
      .toThrow(EgressDeniedError);
  });

  // ── Denied: wrong port ────────────────────────────────────────────────────

  it('rejects a non-standard port for an HTTPS-only destination', () => {
    expect(() => assertAllowedDestination('https://api.amadeus.com:8443/v2/shopping'))
      .toThrow(EgressDeniedError);
  });

  it('rejects port 80 for internal gateway (expects 3000)', () => {
    expect(() => assertAllowedDestination('http://api-gateway.internal/v1/flights/search'))
      .toThrow(EgressDeniedError);
  });

  // ── Denied: not on allow-list ────────────────────────────────────────────

  it('rejects a host that is not on the allow-list', () => {
    const err = (() => {
      try {
        assertAllowedDestination('https://evil.example.com/steal');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).attemptedHost).toBe('evil.example.com');
  });

  it('rejects a sibling subdomain when wildcard is not enabled (api.amadeus.com parent not wildcard)', () => {
    // sub.api.amadeus.com is not the exact allowed host, and api.amadeus.com
    // does not have allowWildcardSubdomains: true.
    expect(() => assertAllowedDestination('https://sub.api.amadeus.com/path'))
      .toThrow(EgressDeniedError);
  });

  // ── Denied: IP literals ───────────────────────────────────────────────────

  it('rejects a raw IPv4 literal', () => {
    const err = (() => {
      try {
        assertAllowedDestination('https://203.0.113.10/path');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toMatch(/IP literal/);
  });

  it('rejects a raw RFC1918 IPv4 literal', () => {
    expect(() => assertAllowedDestination('https://192.168.1.1/path'))
      .toThrow(EgressDeniedError);
  });

  it('rejects the metadata endpoint as an IP literal', () => {
    expect(() => assertAllowedDestination('https://169.254.169.254/'))
      .toThrow(EgressDeniedError);
  });

  // ── Denied: URL contains credentials ────────────────────────────────────

  it('rejects a URL with username in userinfo', () => {
    const err = (() => {
      try {
        assertAllowedDestination('https://user@api.amadeus.com/v2/shopping');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toMatch(/userinfo/);
  });

  it('rejects a URL with password in userinfo', () => {
    expect(() => assertAllowedDestination('https://user:pass@api.stripe.com/v1/charges'))
      .toThrow(EgressDeniedError);
  });

  // ── Denied: invalid URL ──────────────────────────────────────────────────

  it('rejects a non-URL string', () => {
    expect(() => assertAllowedDestination('not a url at all'))
      .toThrow(EgressDeniedError);
  });
});

describe('ALLOWED_DESTINATIONS list integrity', () => {
  it('contains at least one entry for each required provider', () => {
    const hosts = ALLOWED_DESTINATIONS.map((d) => d.host);
    expect(hosts).toContain('api.amadeus.com');
    expect(hosts).toContain('p.rapidapi.com');
    expect(hosts).toContain('api.stripe.com');
    expect(hosts).toContain('api.anthropic.com');
    expect(hosts).toContain('accounts.google.com');
    expect(hosts).toContain('email.eu-west-1.amazonaws.com');
    expect(hosts).toContain('api-gateway.internal');
  });

  it('has no IP literals as host values', () => {
    for (const dest of ALLOWED_DESTINATIONS) {
      expect(dest.host).not.toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(dest.host).not.toContain(':');
    }
  });

  it('has at least one HTTPS destination with no wildcard subdomains for supplier APIs', () => {
    const strictDests = ALLOWED_DESTINATIONS.filter(
      (d) => d.allowedSchemes.includes('https') && d.allowWildcardSubdomains !== true,
    );
    expect(strictDests.length).toBeGreaterThan(0);
  });
});
