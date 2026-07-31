import { isBlockedIPv4, isBlockedIPv6, isBlockedAddress } from '../../src/egress/ipRanges.js';
import { CircuitBreaker } from '../../src/egress/circuitBreaker.js';
import { EgressDeniedError } from '../../src/egress/egressPolicy.js';
import { createHardenedClient } from '../../src/egress/hardenedClient.js';
import { makeResolver, REBINDING_RESOLVER, METADATA_RESOLVER, MIXED_RESOLVER } from '../fixtures/mockResolver.js';

// ---------------------------------------------------------------------------
// IP range tests
// ---------------------------------------------------------------------------

describe('isBlockedIPv4', () => {
  it('blocks RFC1918 10.x.x.x', () => {
    expect(isBlockedIPv4('10.0.0.1')).toBe(true);
    expect(isBlockedIPv4('10.255.255.255')).toBe(true);
  });

  it('blocks RFC1918 172.16-31.x.x', () => {
    expect(isBlockedIPv4('172.16.0.1')).toBe(true);
    expect(isBlockedIPv4('172.31.255.255')).toBe(true);
    expect(isBlockedIPv4('172.15.0.1')).toBe(false);
    expect(isBlockedIPv4('172.32.0.1')).toBe(false);
  });

  it('blocks RFC1918 192.168.x.x', () => {
    expect(isBlockedIPv4('192.168.0.1')).toBe(true);
    expect(isBlockedIPv4('192.168.255.255')).toBe(true);
  });

  it('blocks loopback 127.x.x.x', () => {
    expect(isBlockedIPv4('127.0.0.1')).toBe(true);
    expect(isBlockedIPv4('127.255.255.255')).toBe(true);
  });

  it('blocks link-local 169.254.x.x including the metadata endpoint', () => {
    expect(isBlockedIPv4('169.254.0.1')).toBe(true);
    expect(isBlockedIPv4('169.254.169.254')).toBe(true);
  });

  it('blocks unspecified 0.x.x.x', () => {
    expect(isBlockedIPv4('0.0.0.0')).toBe(true);
    expect(isBlockedIPv4('0.255.255.255')).toBe(true);
  });

  it('allows public documentation range 203.0.113.x', () => {
    expect(isBlockedIPv4('203.0.113.10')).toBe(false);
    expect(isBlockedIPv4('1.1.1.1')).toBe(false);
    expect(isBlockedIPv4('8.8.8.8')).toBe(false);
  });
});

describe('isBlockedIPv6', () => {
  it('blocks loopback ::1', () => {
    expect(isBlockedIPv6('::1')).toBe(true);
  });

  it('blocks unique-local fc00::/7', () => {
    expect(isBlockedIPv6('fc00::1')).toBe(true);
    expect(isBlockedIPv6('fd00::1')).toBe(true);
    expect(isBlockedIPv6('fdff:ffff::1')).toBe(true);
  });

  it('blocks link-local fe80::/10', () => {
    expect(isBlockedIPv6('fe80::1')).toBe(true);
    expect(isBlockedIPv6('fe80::dead:beef')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses', () => {
    expect(isBlockedIPv6('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedIPv6('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedIPv6('2001:db8::1')).toBe(false);
  });
});

describe('isBlockedAddress dispatcher', () => {
  it('dispatches to IPv4 checker for family 4', () => {
    expect(isBlockedAddress('10.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('203.0.113.1', 4)).toBe(false);
  });

  it('dispatches to IPv6 checker for family 6', () => {
    expect(isBlockedAddress('::1', 6)).toBe(true);
    expect(isBlockedAddress('2001:db8::1', 6)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  it('starts CLOSED and allows requests', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canRequest()).toBe(true);
  });

  it('opens after the failure threshold within the window', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 5,
      windowMs: 10_000,
      now: () => nowMs,
    });

    // 5 failures within 10 s
    for (let i = 0; i < 5; i++) {
      nowMs += 1_000;
      cb.recordFailure();
    }

    expect(cb.getState()).toBe('OPEN');
    expect(cb.canRequest()).toBe(false);
  });

  it('does NOT open when failures are outside the rolling window', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 5,
      windowMs: 10_000,
      now: () => nowMs,
    });

    // 4 failures spread over 40 s (each outside the 10 s window of the next)
    for (let i = 0; i < 4; i++) {
      cb.recordFailure();
      nowMs += 15_000;
    }

    expect(cb.getState()).toBe('CLOSED');
    expect(cb.canRequest()).toBe(true);
  });

  it('transitions OPEN → HALF_OPEN after halfOpenAfterMs', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      halfOpenAfterMs: 30_000,
      now: () => nowMs,
    });

    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');

    nowMs += 30_000; // advance past half-open window
    expect(cb.canRequest()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('closes again after a successful probe in HALF_OPEN', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      halfOpenAfterMs: 30_000,
      now: () => nowMs,
    });

    cb.recordFailure();
    nowMs += 30_000;
    cb.canRequest(); // transitions to HALF_OPEN

    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
  });

  it('re-opens after a failed probe in HALF_OPEN', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      halfOpenAfterMs: 30_000,
      now: () => nowMs,
    });

    cb.recordFailure();
    nowMs += 30_000;
    cb.canRequest(); // transitions to HALF_OPEN

    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// Hardened client — DNS rebinding and redirect tests
// ---------------------------------------------------------------------------

describe('createHardenedClient — DNS rebinding protection', () => {
  it('rejects an allow-listed host that resolves to a private RFC1918 address', async () => {
    const client = createHardenedClient({ dnsLookup: REBINDING_RESOLVER });

    await expect(
      client('https://api.amadeus.com/v2/shopping/flight-offers'),
    ).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('rejects an allow-listed host that resolves to the metadata endpoint', async () => {
    const client = createHardenedClient({ dnsLookup: METADATA_RESOLVER });
    const denials: string[] = [];

    const c = createHardenedClient({
      dnsLookup: METADATA_RESOLVER,
      onEgressDenied: (host) => denials.push(host),
    });

    await expect(
      c('https://api.amadeus.com/v2/shopping/flight-offers'),
    ).rejects.toBeInstanceOf(EgressDeniedError);

    expect(denials).toContain('api.amadeus.com');
  });

  it('rejects a host with ANY private address in a multi-record response', async () => {
    const client = createHardenedClient({ dnsLookup: MIXED_RESOLVER });

    await expect(
      client('https://api.amadeus.com/v2/shopping/flight-offers'),
    ).rejects.toBeInstanceOf(EgressDeniedError);
  });
});

describe('createHardenedClient — allow-list enforcement', () => {
  it('rejects a host that is not on the allow-list before DNS resolution', async () => {
    const resolver = makeResolver({
      'evil.example.com': [{ address: '203.0.113.99', family: 4 }],
    });
    const client = createHardenedClient({ dnsLookup: resolver });

    await expect(
      client('https://evil.example.com/payload'),
    ).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('records the denied host in the security event callback', async () => {
    const denials: Array<{ host: string; reason: string }> = [];
    const resolver = makeResolver({
      'evil.example.com': [{ address: '203.0.113.99', family: 4 }],
    });
    const client = createHardenedClient({
      dnsLookup: resolver,
      onEgressDenied: (host, reason) => denials.push({ host, reason }),
    });

    await expect(client('https://evil.example.com/')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(denials[0]?.host).toBe('evil.example.com');
  });
});

describe('createHardenedClient — circuit breaker integration', () => {
  it('throws when the breaker is pre-opened (injectable instance)', async () => {
    let nowMs = 0;
    // Pre-open the breaker by injecting a controllable instance.
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      halfOpenAfterMs: 60_000,
      now: () => nowMs,
    });
    breaker.recordFailure(); // opens immediately (threshold = 1)
    expect(breaker.getState()).toBe('OPEN');

    const resolver = makeResolver({
      'api.amadeus.com': [{ address: '203.0.113.10', family: 4 }],
    });
    const client = createHardenedClient({
      dnsLookup: resolver,
      breakerInstance: breaker,
    });

    // The open breaker blocks the request before any DNS or network I/O.
    await expect(client('https://api.amadeus.com/')).rejects.toThrow('Circuit breaker is OPEN');
  });

  it('allows a request after the breaker transitions to HALF_OPEN', async () => {
    let nowMs = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 10_000,
      halfOpenAfterMs: 30_000,
      now: () => nowMs,
    });
    breaker.recordFailure(); // opens
    nowMs += 30_000; // advance past half-open window

    // HALF_OPEN allows one probe — canRequest() returns true
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.getState()).toBe('HALF_OPEN');
  });
});
