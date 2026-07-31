/**
 * Unit tests for AmadeusTokenProvider.
 *
 * Uses a fake clock, in-memory Redis double, and a stubbed HTTP client.
 * No real network calls are made.
 *
 * Covers:
 *  - Token fetch and cache on first call
 *  - Cache reuse on subsequent calls within TTL
 *  - Forced refresh (del + re-fetch) via refreshToken()
 *  - TTL = expires_in - 60s
 *  - 401/403 from token endpoint → SupplierUnavailableError (alertable)
 *  - 5xx from token endpoint → SupplierUnavailableError
 *  - Network error → SupplierUnavailableError
 */

import { describe, it, expect, vi } from 'vitest';
import { AmadeusTokenProvider } from '../../src/adapters/AmadeusTokenProvider.js';
import { SupplierUnavailableError, SupplierRejectedRequestError } from '@travel/supplier-port';
import type { RedisCache, TokenHttpClient, MinimalLogger } from '../../src/adapters/AmadeusTokenProvider.js';
import tokenFixture from '../fixtures/amadeus/token-response.json';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    sleep: (ms: number) => { now += ms; return Promise.resolve(); },
    advance: (ms: number) => { now += ms; },
  };
}

function makeRedisDouble(): RedisCache & { store: Map<string, { value: string; ttl?: number }> } {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    async get(key: string) {
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async set(key: string, value: string, _mode: 'EX', ttl: number) {
      store.set(key, { value, ttl });
    },
    async del(key: string) {
      store.delete(key);
    },
  };
}

function makeHttpClient(status: number, body: unknown): TokenHttpClient {
  return {
    post: vi.fn(async () => ({
      status,
      json: async () => body,
    })),
  };
}

function makeLogger(): MinimalLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const BASE_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenEndpoint: 'https://test.api.amadeus.com/v1/security/oauth2/token',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AmadeusTokenProvider — happy path', () => {
  it('fetches a token on first call and returns the access_token', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(200, tokenFixture);
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    const token = await provider.getToken('corr-1');
    expect(token).toBe(tokenFixture.access_token);
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  it('calls POST to the configured token endpoint', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(200, tokenFixture);
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await provider.getToken('corr-1');
    expect(httpClient.post).toHaveBeenCalledWith(
      BASE_CONFIG.tokenEndpoint,
      expect.stringContaining('grant_type=client_credentials'),
      expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    );
  });

  it('caches the token in Redis with TTL = expires_in - 60', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(200, tokenFixture);
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await provider.getToken('corr-1');

    const cached = redis.store.get('supplier:amadeus:token');
    expect(cached).toBeDefined();
    expect(cached!.value).toBe(tokenFixture.access_token);
    // expires_in = 1799, TTL should be 1799 - 60 = 1739
    expect(cached!.ttl).toBe(1739);
  });

  it('reuses the cached token on subsequent calls without re-fetching', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(200, tokenFixture);
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    const first = await provider.getToken('corr-1');
    const second = await provider.getToken('corr-2');

    expect(first).toBe(second);
    expect(httpClient.post).toHaveBeenCalledTimes(1); // only one HTTP call
  });
});

describe('AmadeusTokenProvider — forced refresh', () => {
  it('refreshToken() evicts Redis cache and re-fetches', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(200, tokenFixture);
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await provider.getToken('corr-1');
    expect(httpClient.post).toHaveBeenCalledTimes(1);

    await provider.refreshToken('corr-2');
    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });

  it('refreshToken() returns fresh token after cache eviction', async () => {
    const redis = makeRedisDouble();
    const freshFixture = { ...tokenFixture, access_token: 'FRESH_TOKEN_VALUE' };
    const httpClient: TokenHttpClient = {
      post: vi.fn()
        .mockResolvedValueOnce({ status: 200, json: async () => tokenFixture })
        .mockResolvedValueOnce({ status: 200, json: async () => freshFixture }),
    };
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await provider.getToken('corr-1');
    const refreshed = await provider.refreshToken('corr-2');
    expect(refreshed).toBe('FRESH_TOKEN_VALUE');
  });
});

describe('AmadeusTokenProvider — error handling', () => {
  it('throws SupplierUnavailableError on 401 from token endpoint', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(401, { message: 'Unauthorized' });
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow(SupplierUnavailableError);
  });

  it('logs a warn-level alertable event on 401', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(401, {});
    const logger = makeLogger();
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger,
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ alertable: true, httpStatus: 401 }),
      expect.any(String),
    );
  });

  it('throws SupplierUnavailableError on 403 from token endpoint', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(403, {});
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow(SupplierUnavailableError);
  });

  it('throws SupplierRejectedRequestError on other 4xx errors', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(400, {});
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow(SupplierRejectedRequestError);
  });

  it('throws SupplierUnavailableError on 5xx from token endpoint', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(503, {});
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow(SupplierUnavailableError);
  });

  it('throws SupplierUnavailableError on network error', async () => {
    const redis = makeRedisDouble();
    const httpClient: TokenHttpClient = {
      post: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: BASE_CONFIG,
      logger: makeLogger(),
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow(SupplierUnavailableError);
  });

  it('never logs the client secret', async () => {
    const redis = makeRedisDouble();
    const httpClient = makeHttpClient(401, {});
    const logger = makeLogger();
    const provider = new AmadeusTokenProvider({
      redis,
      httpClient,
      clock: makeFakeClock(),
      config: { ...BASE_CONFIG, clientSecret: 'SUPER_SECRET_VALUE' },
      logger,
    });

    await expect(provider.getToken('corr-err')).rejects.toThrow();

    const allLogCalls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const loggedText = JSON.stringify(allLogCalls);
    expect(loggedText).not.toContain('SUPER_SECRET_VALUE');
  });
});
