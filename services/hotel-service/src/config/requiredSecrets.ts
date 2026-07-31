import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for hotel-service.
 *
 * RapidAPI credentials are backed by AWS Secrets Manager. The service
 * refuses to start if either value is absent or matches a known placeholder
 * (enforced by the Phase-0 assertSecretsOrExit validator from WO-012).
 *
 * SUPPLIER_ALLOWED_HOSTS must include the configured RapidAPI provider hostname
 * (e.g. "booking-com15.p.rapidapi.com"). The EgressAllowList in
 * RapidApiHotelAdapter reads this config value.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'RAPIDAPI_KEY',
    description:
      'RapidAPI API key for hotel search. Sent as x-rapidapi-key header. Never logged.',
    allowEmptyInDev: true,
  },
  {
    envVar: 'RAPIDAPI_HOTEL_HOST',
    description:
      'RapidAPI provider hostname for hotel search (e.g. booking-com15.p.rapidapi.com).',
    allowEmptyInDev: true,
  },
];

/**
 * Wildcard root hostname for RapidAPI providers.
 * All provider-specific subdomains (*.p.rapidapi.com) are pre-approved in
 * packages/suppliers ALLOWED_DESTINATIONS. The specific host must also
 * appear in SUPPLIER_ALLOWED_HOSTS at runtime.
 */
export const RAPIDAPI_EGRESS_HOST_SUFFIX = 'p.rapidapi.com';
