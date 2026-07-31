import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for flight-service.
 *
 * Amadeus OAuth2 credentials are backed by AWS Secrets Manager. The service
 * refuses to start if either value is absent or matches a known placeholder
 * (enforced by the Phase-0 assertSecretsOrExit validator from WO-012).
 *
 * SUPPLIER_ALLOWED_HOSTS must list both production and test Amadeus hostnames.
 * The EgressAllowList in AmadeusFlightAdapter reads this config value.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'AMADEUS_CLIENT_ID',
    description: 'Amadeus GDS OAuth2 client ID (paired with AMADEUS_CLIENT_SECRET).',
    allowEmptyInDev: true,
  },
  {
    envVar: 'AMADEUS_CLIENT_SECRET',
    description:
      'Amadeus GDS OAuth2 client secret used to obtain bearer tokens for flight search API calls.',
    allowEmptyInDev: true,
  },
];

/**
 * Hostnames that must be present in SUPPLIER_ALLOWED_HOSTS for this service.
 * Used to initialise EgressAllowList at startup.
 */
export const AMADEUS_ALLOWED_HOSTS = [
  'test.api.amadeus.com',
  'api.amadeus.com',
] as const;
