/**
 * AmadeusTokenProvider — OAuth2 client-credentials token manager.
 *
 * Fetches a bearer token from the Amadeus token endpoint, caches it in Redis
 * under key `supplier:amadeus:token` with TTL = expires_in - 60 seconds, and
 * returns the cached token on subsequent calls until expiry.
 *
 * A 401 response from the token endpoint signals rotated or invalid credentials;
 * it throws SupplierUnavailableError (502) with an alertable warn-level log
 * rather than retrying (retrying bad credentials would lock the account).
 *
 * SECURITY: credentials are never logged, stored in Redis, or returned to callers.
 * Only the access_token (opaque bearer value) is cached.
 */

import {
  SupplierUnavailableError,
  SupplierRejectedRequestError,
  SupplierTimeoutError,
} from '@travel/supplier-port';
import type { Clock } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// Duck-typed interfaces (no concrete dependency on ioredis or pino)
// ---------------------------------------------------------------------------

export interface RedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface TokenResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface TokenHttpClient {
  post(url: string, body: string, headers: Record<string, string>): Promise<TokenResponse>;
}

export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface AmadeusTokenConfig {
  /** Amadeus OAuth2 client ID — from Secrets Manager, never defaulted. */
  readonly clientId: string;
  /** Amadeus OAuth2 client secret — from Secrets Manager, never defaulted. */
  readonly clientSecret: string;
  /** Full URL of the Amadeus token endpoint. */
  readonly tokenEndpoint: string;
}

export interface AmadeusTokenProviderOptions {
  redis: RedisCache;
  httpClient: TokenHttpClient;
  clock: Clock;
  config: AmadeusTokenConfig;
  logger: MinimalLogger;
}

// ---------------------------------------------------------------------------
// Token shape returned by Amadeus
// ---------------------------------------------------------------------------

interface AmadeusTokenPayload {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const REDIS_KEY = 'supplier:amadeus:token';
const SUPPLIER_NAME = 'AMADEUS';
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

// ---------------------------------------------------------------------------
// AmadeusTokenProvider
// ---------------------------------------------------------------------------

export class AmadeusTokenProvider {
  private readonly redis: RedisCache;
  private readonly httpClient: TokenHttpClient;
  private readonly clock: Clock;
  private readonly config: AmadeusTokenConfig;
  private readonly logger: MinimalLogger;

  constructor(opts: AmadeusTokenProviderOptions) {
    this.redis = opts.redis;
    this.httpClient = opts.httpClient;
    this.clock = opts.clock;
    this.config = opts.config;
    this.logger = opts.logger;
  }

  /**
   * Return a valid bearer token, fetching and caching one if necessary.
   * Throws SupplierUnavailableError if the token endpoint is unreachable
   * or returns credentials-failure status codes (401, 403).
   */
  async getToken(correlationId: string): Promise<string> {
    const cached = await this.redis.get(REDIS_KEY);
    if (cached !== null && cached.length > 0) {
      this.logger.info({ event: 'amadeus.token.cache_hit', correlationId }, 'Amadeus token served from Redis cache');
      return cached;
    }
    return this.fetchAndCache(correlationId);
  }

  /**
   * Force a token refresh by evicting the cached value and fetching a new one.
   * Called by AmadeusFlightAdapter when a search call returns 401 (token expired
   * mid-flight or rotated between cache write and search call).
   */
  async refreshToken(correlationId: string): Promise<string> {
    await this.redis.del(REDIS_KEY);
    this.logger.info({ event: 'amadeus.token.cache_evicted', correlationId }, 'Amadeus token cache evicted for forced refresh');
    return this.fetchAndCache(correlationId);
  }

  private async fetchAndCache(correlationId: string): Promise<string> {
    const formBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    }).toString();

    let response: TokenResponse;
    try {
      response = await this.httpClient.post(
        this.config.tokenEndpoint,
        formBody,
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-correlation-id': correlationId,
        },
      );
    } catch (err) {
      if (err instanceof SupplierTimeoutError) throw err;
      this.logger.error(
        { event: 'amadeus.token.fetch_failed', correlationId, error: err instanceof Error ? err.message : String(err) },
        'Amadeus token endpoint unreachable',
      );
      throw new SupplierUnavailableError(SUPPLIER_NAME, correlationId);
    }

    if (response.status === 401 || response.status === 403) {
      // Rotated or invalid credentials — alertable, do not retry
      this.logger.warn(
        {
          event: 'amadeus.token.credential_failure',
          correlationId,
          httpStatus: response.status,
          alertable: true,
        },
        `Amadeus token endpoint returned ${response.status} — credentials may be invalid or rotated`,
      );
      throw new SupplierUnavailableError(SUPPLIER_NAME, correlationId, response.status);
    }

    if (response.status >= 400 && response.status < 500) {
      throw new SupplierRejectedRequestError(SUPPLIER_NAME, correlationId, response.status);
    }

    if (response.status >= 500) {
      throw new SupplierUnavailableError(SUPPLIER_NAME, correlationId, response.status);
    }

    const payload = (await response.json()) as AmadeusTokenPayload;

    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new SupplierUnavailableError(SUPPLIER_NAME, correlationId);
    }

    const ttlSeconds = Math.max(1, payload.expires_in - TOKEN_EXPIRY_BUFFER_SECONDS);
    await this.redis.set(REDIS_KEY, payload.access_token, 'EX', ttlSeconds);

    this.logger.info(
      { event: 'amadeus.token.fetched', correlationId, ttlSeconds },
      'Amadeus token fetched and cached',
    );

    return payload.access_token;
  }
}
