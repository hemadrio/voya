/**
 * Hotel service composition root.
 *
 * Wires RapidApiHotelAdapter with its dependencies using constructor injection.
 * All credentials come from environment variables validated at startup by
 * assertSecretsOrExit — this file must never read process.env directly.
 *
 * SUPPLIER_ALLOWED_HOSTS must include the configured RapidAPI provider hostname
 * (e.g. "booking-com15.p.rapidapi.com"). The wildcard *.p.rapidapi.com is
 * already in packages/suppliers ALLOWED_DESTINATIONS (layer 2 SSRF protection).
 */

import { realClock, SupplierHttpClient, EgressAllowList } from '@travel/supplier-port';
import { createHardenedClient } from '@travel/suppliers';
import { RapidApiHotelAdapter } from './adapters/RapidApiHotelAdapter.js';
import type { MinimalLogger } from './adapters/RapidApiHotelAdapter.js';

export interface HotelServiceConfig {
  /**
   * RapidAPI API key — injected from Secrets Manager.
   * Sent as the x-rapidapi-key header. Never logged or stored in any derivative form.
   */
  rapidApiKey: string;
  /**
   * RapidAPI provider hostname for hotel search
   * (e.g. "booking-com15.p.rapidapi.com" for the Booking.com provider on RapidAPI).
   * Also sent as the x-rapidapi-host header.
   */
  rapidApiHost: string;
  logger: MinimalLogger;
}

/**
 * Create and wire the RapidAPI hotel adapter.
 *
 * Called once at service startup. The returned adapter implements SupplierPort
 * and can be registered directly in the search service fan-out.
 */
export function createRapidApiHotelAdapter(config: HotelServiceConfig): RapidApiHotelAdapter {
  const rapidApiHost = config.rapidApiHost;
  const searchEndpoint = `https://${rapidApiHost}/hotels/search`;

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

  return new RapidApiHotelAdapter({
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
