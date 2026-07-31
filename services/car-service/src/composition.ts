/**
 * Car service composition root.
 *
 * Wires RapidApiCarAdapter with its dependencies using constructor injection.
 * All credentials come from environment variables validated at startup by
 * assertSecretsOrExit — this file must never read process.env directly.
 *
 * See services/car-service/README.md for the provider selection rationale
 * (RapidAPI chosen over Priceline due to existing credential + egress policy).
 *
 * SUPPLIER_ALLOWED_HOSTS must include the configured RapidAPI provider hostname
 * (e.g. "booking-com15.p.rapidapi.com"). The wildcard *.p.rapidapi.com is
 * already in packages/suppliers ALLOWED_DESTINATIONS (layer 2 SSRF protection).
 */

import { realClock, SupplierHttpClient, EgressAllowList } from '@travel/supplier-port';
import { createHardenedClient } from '@travel/suppliers';
import { RapidApiCarAdapter } from './adapters/RapidApiCarAdapter.js';
import type { MinimalLogger } from './adapters/RapidApiCarAdapter.js';

export interface CarServiceConfig {
  /**
   * RapidAPI API key — injected from Secrets Manager.
   * Sent as the x-rapidapi-key header. Never logged.
   */
  rapidApiKey: string;
  /**
   * RapidAPI provider hostname for car rental search
   * (e.g. "booking-com15.p.rapidapi.com").
   * Also sent as the x-rapidapi-host header.
   */
  rapidApiCarHost: string;
  logger: MinimalLogger;
}

/**
 * Create and wire the RapidAPI car rental adapter.
 *
 * Called once at service startup. The returned adapter implements SupplierPort
 * and can be registered directly in the search service fan-out.
 */
export function createRapidApiCarAdapter(config: CarServiceConfig): RapidApiCarAdapter {
  const rapidApiHost = config.rapidApiCarHost;
  const searchEndpoint = `https://${rapidApiHost}/cars/search`;

  const hardenedFetch = createHardenedClient({ timeoutMs: 2_200 });

  const egressAllowList = new EgressAllowList({
    allowedHosts: [rapidApiHost],
    logger: config.logger,
  });

  const httpClient = new SupplierHttpClient({
    supplierName: 'RAPIDAPI',
    transport: hardenedFetch,
    egressAllowList,
    defaultTimeoutMs: 2_200,
    clock: realClock,
  });

  return new RapidApiCarAdapter({
    httpClient,
    clock: realClock,
    config: {
      apiKey: config.rapidApiKey,
      apiHost: rapidApiHost,
      searchEndpoint,
      defaultOfferValidityMinutes: 30,
    },
    logger: config.logger,
  });
}
