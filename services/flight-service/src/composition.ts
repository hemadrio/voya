/**
 * Flight service composition root.
 *
 * Wires AmadeusFlightAdapter with its dependencies using constructor injection.
 * All credentials come from environment variables validated at startup by
 * assertSecretsOrExit — this file must never read process.env directly.
 *
 * SUPPLIER_ALLOWED_HOSTS must include 'test.api.amadeus.com' and 'api.amadeus.com'
 * for production and 'test.api.amadeus.com' for staging/dev environments.
 */

import { realClock, SupplierHttpClient, EgressAllowList } from '@travel/supplier-port';
import { createHardenedClient } from '@travel/suppliers';
import { AmadeusTokenProvider } from './adapters/AmadeusTokenProvider.js';
import { AmadeusFlightAdapter } from './adapters/AmadeusFlightAdapter.js';
import type { MinimalLogger } from './adapters/AmadeusTokenProvider.js';

export interface FlightServiceConfig {
  /** Amadeus OAuth2 client ID — injected from Secrets Manager. */
  amadeusClientId: string;
  /** Amadeus OAuth2 client secret — injected from Secrets Manager. */
  amadeusClientSecret: string;
  /**
   * Base API host — determines which Amadeus environment to use.
   * 'test.api.amadeus.com' in dev/staging, 'api.amadeus.com' in production.
   */
  amadeusHost: string;
  /** Redis client (ioredis or compatible) for token caching. */
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
  };
  logger: MinimalLogger;
}

/**
 * Create and wire the Amadeus flight adapter.
 *
 * Called once at service startup. The returned adapter is registered as the
 * flight supplier in the search service fan-out.
 */
export function createAmadeusFlightAdapter(config: FlightServiceConfig): AmadeusFlightAdapter {
  const amadeusHost = config.amadeusHost;
  const tokenEndpoint = `https://${amadeusHost}/v1/security/oauth2/token`;
  const searchEndpoint = `https://${amadeusHost}/v2/shopping/flight-offers`;

  const hardenedFetch = createHardenedClient({ timeoutMs: 2_200 });

  const egressAllowList = new EgressAllowList({
    allowedHosts: [amadeusHost],
    logger: config.logger,
  });

  const httpClient = new SupplierHttpClient({
    supplierName: 'AMADEUS',
    transport: hardenedFetch,
    egressAllowList,
    defaultTimeoutMs: 2_200,
    clock: realClock,
  });

  // Token provider uses a lightweight wrapper around hardenedFetch.
  // Wraps HardenedResponse into the TokenHttpClient shape so generic json<T>()
  // is exposed as non-generic json(): Promise<unknown>.
  const tokenHttpClient = {
    async post(
      url: string,
      body: string,
      headers: Record<string, string>,
    ): Promise<{ status: number; json(): Promise<unknown> }> {
      const response = await hardenedFetch(url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 5_000,
      });
      return {
        status: response.status,
        json: () => response.json<unknown>(),
      };
    },
  };

  const tokenProvider = new AmadeusTokenProvider({
    redis: config.redis,
    httpClient: tokenHttpClient,
    clock: realClock,
    config: {
      clientId: config.amadeusClientId,
      clientSecret: config.amadeusClientSecret,
      tokenEndpoint,
    },
    logger: config.logger,
  });

  return new AmadeusFlightAdapter({
    tokenProvider,
    httpClient,
    clock: realClock,
    config: {
      searchEndpoint,
      defaultOfferValidityMinutes: 60,
    },
    logger: config.logger,
  });
}
